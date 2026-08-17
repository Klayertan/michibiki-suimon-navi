// Account surface: login/onboarding screen, header account menu, the
// signed-in 「あなたの圃場」 list, the local-data import offer, and the
// Settings → アカウント section.
//
// Follows the same shape as every other controller in this repo (an ES module
// class bound to elements by id, fed live state through constructor
// callbacks) so it drops into index.html's existing init() sequence without
// Supabase calls leaking into the page — brief §20.
//
// WHAT IT DOES NOT DO:
//   - It does not own field data. The FieldAnnotationController remains the
//     domain/local persistence boundary; this controller only re-points which
//     storage namespace that controller reads through, and asks it to
//     re-hydrate.
//   - It does not create a second field selector. Choosing a paddy from
//     「あなたの圃場」 drives the existing #basicActiveFieldSelect, which is
//     the one authoritative active field (brief §15).
//   - It does not block anything. If the cloud is unconfigured, unreachable,
//     or broken, the app is exactly the offline-first app it was before.

import {
  PROVIDER_MOCK,
  readCloudConfig,
  resolveRedirectUrl,
  unconfiguredReasonText
} from "../cloud/cloud-config.js";
import {
  AUTH_ERROR,
  AUTH_GUEST,
  AUTH_OFFLINE_AUTHENTICATED,
  AUTH_SIGNED_IN,
  AUTH_SIGNED_OUT,
  AUTH_UNAVAILABLE,
  AUTH_UNKNOWN,
  accountLabel,
  accountStatusText,
  deriveAuthState,
  isAuthenticated,
  shouldShowLoginScreen
} from "./auth-state.js";
import { authErrorMessage, isOfflineError, validateCredentials } from "./auth-errors.js";
import { FieldSyncService } from "../cloud/field-sync-service.js";
import {
  KIND_FIELD,
  KIND_OBSERVATION,
  KIND_WATER_POINT,
  localImportPromptText,
  markPending,
  planLocalImport
} from "../cloud/field-sync-core.js";
import { ScopedStorage, readScoped, scopeHasFields } from "../cloud/user-scope.js";

const GUEST_CHOICE_KEY = "suimonNaviAuthChoiceV1";
const IMPORT_CHOICE_KEY = "suimonNaviLocalImportChoiceV1";
const FIELD_STORE_KEY = "suimonNaviFieldAnnotationsV2";
const WATER_TARGET_KEY = "suimonNaviTargetWaterLevelV1";

const ELEMENT_IDS = [
  // Login / onboarding screen.
  "authScreen", "authForm", "authTitle", "authSubtitle", "authEmailInput", "authPasswordInput",
  "authDisplayNameRow", "authDisplayNameInput", "authSubmitButton", "authSwitchRow",
  "authSwitchPrompt", "authSwitchButton", "authGuestButton", "authMessage", "authCloseButton",
  // Header account control.
  "accountControl", "accountMenuButton", "accountMenuLabel", "accountMenu",
  "accountMenuIdentity", "accountMenuStatus", "accountMenuSync",
  "accountMenuSyncNowButton", "accountMenuLoginButton", "accountMenuLogoutButton",
  "syncStatusChip",
  // 基本モード signed-in field home.
  "accountFieldsCard", "accountFieldsList", "accountFieldsEmpty", "accountFieldsNewButton",
  // Local -> account import offer.
  "localImportPrompt", "localImportPromptText", "localImportAcceptButton", "localImportSkipButton",
  "localImportMessage",
  // 設定 → アカウント.
  "settingsAccountPanel", "settingsAccountIdentity", "settingsAccountStatus", "settingsSyncStatus",
  "settingsSyncNowButton", "settingsLoginButton", "settingsLogoutButton", "settingsAccountMessage"
];

export class AuthController extends EventTarget {
  /**
   * @param {object} options
   * @param {Function} options.getFieldController  () => FieldAnnotationController | null
   * @param {object}   options.scopedStorage       ScopedStorage shared with the field controller
   * @param {Function} options.onScopeChanged      () => void — re-render everything that reads field data
   * @param {Function} options.onSelectField       (localFieldId) => void — drives the ONE active field
   * @param {Function} options.onRequestNewField   () => void — 「＋ 新しい圃場を測る」
   * @param {Function} options.getWaterTargets     () => ({ [fieldId]: number })
   * @param {Function} options.setWaterTargets     (map) => void
   */
  constructor(options = {}) {
    super();
    this.getFieldController = options.getFieldController || (() => null);
    this.scopedStorage = options.scopedStorage || new ScopedStorage(typeof localStorage !== "undefined" ? localStorage : null);
    this.backingStorage = options.backingStorage || (typeof localStorage !== "undefined" ? localStorage : null);
    this.onScopeChanged = options.onScopeChanged || (() => {});
    this.onSelectField = options.onSelectField || (() => {});
    this.onRequestNewField = options.onRequestNewField || (() => {});
    this.getWaterTargets = options.getWaterTargets || (() => ({}));
    this.setWaterTargets = options.setWaterTargets || (() => {});
    this.globalScope = options.globalScope || (typeof window !== "undefined" ? window : {});

    this.config = { configured: false, reason: "missing" };
    this.authClient = null;
    this.store = null;
    this.syncService = null;
    this.state = AUTH_UNKNOWN;
    this.currentUserId = null;
    this.formMode = "login";
    this.loginRequested = false;
    this.busy = false;
    this.elements = {};
    this.pendingImport = null;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async mount() {
    ELEMENT_IDS.forEach((id) => { this.elements[id] = document.getElementById(id); });
    if (!this.elements.authScreen) {
      return false;
    }
    this.bindEvents();

    this.config = readCloudConfig(this.globalScope);
    this.config.redirectTo = resolveRedirectUrl(this.globalScope.location, this.config.redirectTo);

    if (!this.config.configured) {
      // The shipped state: no credentials committed, so there is no account
      // feature and the app is the offline-first app it has always been. This
      // is a deliberate, documented outcome, not a failure — see brief §30.
      this.state = AUTH_UNAVAILABLE;
      this.render();
      return true;
    }

    try {
      await this.initProvider();
    } catch (error) {
      // The SDK could not be fetched (offline, blocked CDN, bad sdkUrl).
      // Degrade to local-only rather than trapping the farmer.
      console.warn("Cloud auth unavailable:", error?.message || error);
      this.config = { ...this.config, configured: false, reason: "provider" };
      this.state = AUTH_UNAVAILABLE;
      this.render();
      return true;
    }

    const session = this.authClient.getSession();
    this.state = deriveAuthState({
      configured: true,
      session,
      online: this.online(),
      guestChosen: this.guestChosen()
    });

    if (session?.user?.id) {
      this.currentUserId = session.user.id;
      await this.enterUserScope(session.user.id, { initialLoad: true });
    }
    this.render();

    if (isAuthenticated(this.state)) {
      this.syncService?.syncNow({ silent: true });
    }
    return true;
  }

  async initProvider() {
    if (this.config.provider === PROVIDER_MOCK) {
      const [{ MockAuthClient }, { MockCloudStore }] = await Promise.all([
        import("./mock-auth-client.js"),
        import("../cloud/mock-cloud-store.js")
      ]);
      this.authClient = new MockAuthClient({ seed: this.globalScope.SUISUI_CLOUD_CONFIG?.mock || {} });
      await this.authClient.init();
      this.store = new MockCloudStore({ getAccessToken: () => this.authClient.getAccessToken() });
      // Tests flip these together to simulate losing signal.
      this.globalScope.__suisuiMock = {
        setOnline: (online) => {
          this.authClient.setOnline(online);
          this.store.setOnline(online);
        },
        store: this.store
      };
    } else {
      const [{ SupabaseAuthClient }, { SupabaseCloudStore }] = await Promise.all([
        import("./supabase-auth-client.js"),
        import("../cloud/supabase-cloud-store.js")
      ]);
      this.authClient = new SupabaseAuthClient(this.config);
      await this.authClient.init();
      this.store = new SupabaseCloudStore({ getClient: () => this.authClient.getClient() });
    }

    this.syncService = new FieldSyncService({
      store: this.store,
      storage: this.scopedStorage,
      isAuthenticated: () => isAuthenticated(this.state),
      getLocalData: () => this.readLocalData(),
      applyRemote: (patch) => this.applyRemotePatch(patch)
    });
    this.syncService.addEventListener("status", () => this.renderSyncStatus());

    this.authClient.onAuthStateChange((session) => this.handleProviderSessionChange(session));

    // A farmer who walks back into coverage should not have to press anything.
    this.globalScope.addEventListener?.("online", () => {
      if (isAuthenticated(this.state)) {
        this.state = AUTH_SIGNED_IN;
        this.render();
        this.syncService?.syncNow({ silent: true });
      }
    });
    this.globalScope.addEventListener?.("offline", () => {
      if (this.state === AUTH_SIGNED_IN) {
        this.state = AUTH_OFFLINE_AUTHENTICATED;
        this.render();
      }
    });
  }

  bindEvents() {
    const el = this.elements;
    el.authForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      this.submitCredentials();
    });
    el.authSwitchButton?.addEventListener("click", () => this.setFormMode(this.formMode === "login" ? "signup" : "login"));
    el.authGuestButton?.addEventListener("click", () => this.continueAsGuest());
    el.authCloseButton?.addEventListener("click", () => this.continueAsGuest({ remember: false }));

    el.accountMenuButton?.addEventListener("click", () => this.toggleAccountMenu());
    el.accountMenuLoginButton?.addEventListener("click", () => this.requestLoginScreen());
    el.accountMenuLogoutButton?.addEventListener("click", () => this.signOut());
    el.accountMenuSyncNowButton?.addEventListener("click", () => this.syncNow());

    el.settingsLoginButton?.addEventListener("click", () => this.requestLoginScreen());
    el.settingsLogoutButton?.addEventListener("click", () => this.signOut());
    el.settingsSyncNowButton?.addEventListener("click", () => this.syncNow());

    el.accountFieldsList?.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-account-field-id]");
      if (button) {
        this.selectField(button.dataset.accountFieldId);
      }
    });
    el.accountFieldsNewButton?.addEventListener("click", () => this.onRequestNewField());

    el.localImportAcceptButton?.addEventListener("click", () => this.acceptLocalImport());
    el.localImportSkipButton?.addEventListener("click", () => this.skipLocalImport());

    // Closing the account menu on an outside tap, the same interaction the
    // Stage-1 help dialog already uses.
    document.addEventListener("click", (event) => {
      if (!this.elements.accountControl || this.elements.accountMenu?.hidden) {
        return;
      }
      if (!this.elements.accountControl.contains(event.target)) {
        this.closeAccountMenu();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") {
        return;
      }
      if (!this.elements.accountMenu?.hidden) {
        this.closeAccountMenu();
      } else if (!this.elements.authScreen?.hidden && this.loginRequested) {
        this.continueAsGuest({ remember: false });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Guest / session choices
  // -------------------------------------------------------------------------

  online() {
    return typeof navigator === "undefined" || navigator.onLine !== false;
  }

  guestChosen() {
    try {
      return this.backingStorage?.getItem(GUEST_CHOICE_KEY) === "guest";
    } catch {
      return false;
    }
  }

  rememberGuestChoice(remember) {
    try {
      if (remember) {
        this.backingStorage?.setItem(GUEST_CHOICE_KEY, "guest");
      } else {
        this.backingStorage?.removeItem(GUEST_CHOICE_KEY);
      }
    } catch {
      // Private browsing: the login screen will simply be offered again.
    }
  }

  continueAsGuest({ remember = true } = {}) {
    if (remember) {
      this.rememberGuestChoice(true);
    }
    this.loginRequested = false;
    if (!isAuthenticated(this.state)) {
      this.state = AUTH_GUEST;
    }
    this.setAuthMessage("");
    this.render();
  }

  requestLoginScreen() {
    this.closeAccountMenu();
    this.loginRequested = true;
    this.setFormMode("login");
    this.setAuthMessage("");
    this.render();
    this.elements.authEmailInput?.focus();
  }

  // -------------------------------------------------------------------------
  // Credentials
  // -------------------------------------------------------------------------

  setFormMode(mode) {
    this.formMode = mode === "signup" ? "signup" : "login";
    this.setAuthMessage("");
    this.renderAuthScreen();
  }

  async submitCredentials() {
    if (this.busy || !this.authClient) {
      return;
    }
    const email = this.elements.authEmailInput?.value ?? "";
    const password = this.elements.authPasswordInput?.value ?? "";
    const displayName = this.elements.authDisplayNameInput?.value ?? "";

    const validationError = validateCredentials({ email, password, mode: this.formMode });
    if (validationError) {
      this.setAuthMessage(validationError);
      return;
    }
    if (!this.online()) {
      this.setAuthMessage(authErrorMessage({ name: "NetworkError" }, this.formMode));
      return;
    }

    this.setBusy(true);
    try {
      const result = this.formMode === "signup"
        ? await this.authClient.signUp({ email, password, displayName })
        : await this.authClient.signIn({ email, password });

      // Passwords are never retained: the inputs are cleared the moment the
      // provider has been called, so a shared phone left unlocked does not
      // hand the next person a filled-in password field.
      this.clearCredentialInputs();

      if (result.needsEmailConfirmation) {
        this.setAuthMessage("確認メールを送信しました。メール内のリンクを開いてから、もう一度ログインしてください。");
        return;
      }
      await this.completeSignIn(result.session);
    } catch (error) {
      this.state = isOfflineError(error) ? this.state : AUTH_ERROR;
      this.setAuthMessage(authErrorMessage(error, this.formMode));
      this.render();
    } finally {
      this.setBusy(false);
    }
  }

  clearCredentialInputs() {
    if (this.elements.authPasswordInput) {
      this.elements.authPasswordInput.value = "";
    }
  }

  /**
   * Idempotent on purpose. The provider fires its own auth-state event during
   * `signIn()`, so this can be reached twice for one sign-in — once from the
   * listener and once from the awaited call. Entering the same user's scope
   * twice would re-run the import check and re-render for nothing.
   */
  async completeSignIn(session) {
    const userId = session?.user?.id;
    if (!userId) {
      this.setAuthMessage(authErrorMessage(null, this.formMode));
      return;
    }
    if (this.currentUserId === userId && isAuthenticated(this.state)) {
      return;
    }
    this.currentUserId = userId;
    this.loginRequested = false;
    this.rememberGuestChoice(false);
    this.state = deriveAuthState({ configured: true, session, online: this.online() });
    await this.enterUserScope(userId);
    this.render();

    // Local-first: the account view is already usable from cache before this
    // resolves, so it is intentionally not awaited by the UI path.
    this.syncService?.syncNow({ silent: true }).then(() => this.render());

    // Best effort — a missing profile row must not block sign-in.
    this.store?.upsertProfile?.({ displayName: session.user.displayName || "" }).catch(() => {});
  }

  handleProviderSessionChange(session) {
    if (session?.user?.id) {
      if (this.state !== AUTH_SIGNED_IN && this.state !== AUTH_OFFLINE_AUTHENTICATED) {
        this.completeSignIn(session);
      }
      return;
    }
    if (isAuthenticated(this.state)) {
      // The provider ended the session behind our back (expired refresh
      // token, revoked from another device). Treat it as a logout.
      this.finishSignOut();
    }
  }

  async signOut() {
    this.closeAccountMenu();
    if (!this.authClient) {
      return;
    }
    this.setBusy(true);
    try {
      await this.authClient.signOut();
    } catch (error) {
      this.setSettingsMessage(authErrorMessage(error, "logout"));
    } finally {
      this.setBusy(false);
      this.finishSignOut();
    }
  }

  /**
   * Brief §22: local data is NOT deleted. The scope simply returns to guest,
   * so the signed-out account's cache stays under its own namespaced key —
   * invisible to whoever signs in next (§23), and instantly available if the
   * same farmer signs back in on this device with no signal.
   */
  finishSignOut() {
    this.state = AUTH_SIGNED_OUT;
    this.currentUserId = null;
    this.pendingImport = null;
    this.setImportMessage("");
    this.rememberGuestChoice(false);
    this.applyScope(null);
    this.setSettingsMessage("ログアウトしました。この端末に保存された圃場データは削除していません。");
    this.render();
  }

  // -------------------------------------------------------------------------
  // Storage scope
  // -------------------------------------------------------------------------

  applyScope(userId) {
    const changed = this.scopedStorage.setUserId(userId);
    if (!changed) {
      return false;
    }
    const controller = this.getFieldController();
    if (controller) {
      // The controller already reads/writes through `options.storage`; all
      // that changed underneath it is which physical key that resolves to.
      controller.hydrateFromStorage();
      controller.renderAll();
    }
    this.syncService?.reloadForCurrentScope();
    this.onScopeChanged();
    return true;
  }

  /**
   * Re-points local storage at this user's namespace, then decides whether to
   * offer the guest-data import (brief §17).
   *
   * The offer is made on an actual sign-in only, and at most once per user per
   * device: re-asking on every page reload would be nagging, and auto-
   * importing would silently upload paddies the farmer may not want in this
   * account.
   */
  async enterUserScope(userId, { initialLoad = false } = {}) {
    const accountHadFields = scopeHasFields(this.backingStorage, userId, FIELD_STORE_KEY);
    const guestFields = this.readGuestFields();
    this.applyScope(userId);

    this.pendingImport = null;
    if (initialLoad || guestFields.length === 0 || this.importChoiceFor(userId)) {
      return;
    }
    const controller = this.getFieldController();
    const plan = planLocalImport({
      guestRecords: guestFields,
      accountRecords: controller?.fields || []
    });
    if (plan.count > 0) {
      this.pendingImport = { userId, plan, accountHadFields };
    }
  }

  readGuestFields() {
    const raw = readScoped(this.backingStorage, FIELD_STORE_KEY, null);
    if (!raw) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.fields) ? parsed.fields : [];
    } catch {
      return [];
    }
  }

  readGuestStore() {
    const raw = readScoped(this.backingStorage, FIELD_STORE_KEY, null);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  importChoiceFor(userId) {
    try {
      const raw = this.backingStorage?.getItem(IMPORT_CHOICE_KEY);
      return raw ? JSON.parse(raw)?.[userId] || null : null;
    } catch {
      return null;
    }
  }

  rememberImportChoice(userId, choice) {
    try {
      const raw = this.backingStorage?.getItem(IMPORT_CHOICE_KEY);
      const all = raw ? JSON.parse(raw) : {};
      all[userId] = choice;
      this.backingStorage?.setItem(IMPORT_CHOICE_KEY, JSON.stringify(all));
    } catch {
      // The offer will simply be made again next sign-in.
    }
  }

  /**
   * Brief §17: adopt the guest-mode paddies into the signed-in account.
   *
   * The guest copy is COPIED, never moved: the farmer keeps working offline
   * without an account exactly as before, and nothing is destroyed if they
   * later decide the account was a mistake. Records already present in the
   * account (same local id) are skipped, which is the duplicate guard.
   */
  acceptLocalImport() {
    const pending = this.pendingImport;
    const controller = this.getFieldController();
    if (!pending || !controller) {
      return;
    }
    const guest = this.readGuestStore();
    if (!guest) {
      this.dismissImportPrompt(pending.userId, "imported");
      return;
    }
    const adoptedFieldIds = new Set(pending.plan.importable.map((field) => String(field.id)));
    const existingFieldIds = new Set(controller.fields.map((field) => String(field.id)));

    controller.fields = [...controller.fields, ...pending.plan.importable];

    const adopt = (localList, guestList, belongsToAdoptedField) => {
      const existing = new Set(localList.map((record) => String(record.id)));
      const added = (guestList || []).filter((record) => !existing.has(String(record.id)) && belongsToAdoptedField(record));
      return { list: [...localList, ...added], added };
    };

    // Only the children of the paddies actually being adopted come across —
    // a water point attached to a field the account already had would be a
    // duplicate of that field's own point.
    const relevant = (fieldId) => adoptedFieldIds.has(String(fieldId)) && !existingFieldIds.has(String(fieldId));

    const points = adopt(controller.waterControlPoints, guest.waterControlPoints, (record) => relevant(record.relatedFieldId));
    controller.waterControlPoints = points.list;
    const observations = adopt(controller.fieldObservations, guest.fieldObservations, (record) => relevant(record.fieldId));
    controller.fieldObservations = observations.list;
    const sessions = adopt(controller.surveySessions, guest.surveySessions, (record) => relevant(record.fieldId));
    controller.surveySessions = sessions.list;
    const tracks = adopt(controller.boundaryTracks, guest.boundaryTracks, (record) => relevant(record.fieldId));
    controller.boundaryTracks = tracks.list;

    controller.persist();
    controller.renderAll();

    // Target water levels for the adopted paddies.
    const guestTargetsRaw = readScoped(this.backingStorage, WATER_TARGET_KEY, null);
    if (guestTargetsRaw) {
      try {
        const guestTargets = JSON.parse(guestTargetsRaw) || {};
        const current = this.getWaterTargets();
        const merged = { ...current };
        Object.entries(guestTargets).forEach(([fieldId, value]) => {
          if (adoptedFieldIds.has(String(fieldId)) && !(fieldId in merged)) {
            merged[fieldId] = value;
          }
        });
        this.setWaterTargets(merged);
      } catch {
        // A corrupt target map is not worth failing the import over.
      }
    }

    let metadata = this.syncService?.metadata;
    if (this.syncService) {
      pending.plan.importable.forEach((field) => { metadata = markPending(metadata, KIND_FIELD, field.id); });
      points.added.forEach((point) => { metadata = markPending(metadata, KIND_WATER_POINT, point.id); });
      observations.added.forEach((observation) => { metadata = markPending(metadata, KIND_OBSERVATION, observation.id); });
      this.syncService.writeMetadata(metadata);
    }

    this.setImportMessage(`${pending.plan.count}件の圃場をアカウントに追加しました。端末内のデータはそのまま残しています。`);
    this.dismissImportPrompt(pending.userId, "imported");
    this.onScopeChanged();
    this.syncService?.syncNow({ silent: true }).then(() => this.render());
  }

  skipLocalImport() {
    const pending = this.pendingImport;
    if (!pending) {
      return;
    }
    this.setImportMessage("端末内の圃場はそのまま残ります。あとで 設定 → アカウント から追加できます。");
    this.dismissImportPrompt(pending.userId, "skipped");
  }

  dismissImportPrompt(userId, choice) {
    this.rememberImportChoice(userId, choice);
    this.pendingImport = null;
    this.render();
  }

  // -------------------------------------------------------------------------
  // Local data bridge for the sync service
  // -------------------------------------------------------------------------

  readLocalData() {
    const controller = this.getFieldController();
    return {
      fields: controller?.fields || [],
      waterControlPoints: controller?.waterControlPoints || [],
      fieldObservations: controller?.fieldObservations || [],
      waterTargets: this.getWaterTargets()
    };
  }

  applyRemotePatch(patch) {
    const controller = this.getFieldController();
    if (!controller) {
      return;
    }
    if (patch.fields) {
      controller.fields = patch.fields;
    }
    if (patch.waterControlPoints) {
      controller.waterControlPoints = patch.waterControlPoints;
    }
    if (patch.fieldObservations) {
      controller.fieldObservations = patch.fieldObservations;
    }
    if (patch.fields || patch.waterControlPoints || patch.fieldObservations) {
      controller.persist();
      controller.renderAll();
    }
    if (patch.waterTargets) {
      this.setWaterTargets(patch.waterTargets);
    }
    this.onScopeChanged();
    this.renderAccountFields();
  }

  /** Called by index.html after any local field mutation while signed in. */
  notifyLocalChange() {
    this.syncService?.scheduleSync();
    this.renderAccountFields();
  }

  async syncNow() {
    this.closeAccountMenu();
    if (!this.syncService) {
      return;
    }
    const result = await this.syncService.syncNow();
    if (result.ok) {
      this.setSettingsMessage("同期しました。");
    } else if (result.message) {
      this.setSettingsMessage(result.message);
    } else if (result.reason === "offline") {
      this.setSettingsMessage("オフラインのため同期できません。データは端末に保存されています。");
    }
    this.render();
  }

  selectField(localFieldId) {
    this.onSelectField(localFieldId);
    this.renderAccountFields();
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  setBusy(busy) {
    this.busy = busy;
    const button = this.elements.authSubmitButton;
    if (button) {
      button.disabled = busy;
      button.textContent = busy ? "処理中…" : this.submitLabel();
    }
  }

  submitLabel() {
    return this.formMode === "signup" ? "アカウントを作成" : "ログイン";
  }

  setAuthMessage(message) {
    const element = this.elements.authMessage;
    if (element) {
      element.textContent = message;
      element.hidden = !message;
    }
  }

  setSettingsMessage(message) {
    const element = this.elements.settingsAccountMessage;
    if (element) {
      element.textContent = message;
    }
  }

  setImportMessage(message) {
    const element = this.elements.localImportMessage;
    if (element) {
      element.textContent = message;
      element.hidden = !message;
    }
  }

  render() {
    this.renderAuthScreen();
    this.renderAccountControl();
    this.renderAccountFields();
    this.renderImportPrompt();
    this.renderSettingsPanel();
    this.renderSyncStatus();
    this.dispatchEvent(new CustomEvent("statechange", { detail: { state: this.state } }));
  }

  renderAuthScreen() {
    const el = this.elements;
    if (!el.authScreen) {
      return;
    }
    const visible = shouldShowLoginScreen({
      state: this.state,
      guestChosen: this.guestChosen(),
      requested: this.loginRequested
    });
    el.authScreen.hidden = !visible;
    // The login screen is a full-page surface; leaving the app behind it
    // scrollable makes a phone feel broken.
    document.body.classList.toggle("auth-screen-open", visible);
    if (!visible) {
      return;
    }
    const signup = this.formMode === "signup";
    if (el.authTitle) el.authTitle.textContent = signup ? "アカウントを作成" : "ログイン";
    if (el.authSubtitle) el.authSubtitle.textContent = "圃場管理をもっと簡単に";
    if (el.authDisplayNameRow) el.authDisplayNameRow.hidden = !signup;
    if (el.authSubmitButton && !this.busy) el.authSubmitButton.textContent = this.submitLabel();
    if (el.authSwitchPrompt) el.authSwitchPrompt.textContent = signup ? "すでにアカウントをお持ちの方" : "初めての方";
    if (el.authSwitchButton) el.authSwitchButton.textContent = signup ? "ログイン" : "アカウントを作成";
    if (el.authPasswordInput) {
      el.authPasswordInput.autocomplete = signup ? "new-password" : "current-password";
    }
    // Only offer "close" when the farmer opened this themselves; on the very
    // first launch the two real choices are login and ログインせずに使う.
    if (el.authCloseButton) el.authCloseButton.hidden = !this.loginRequested;
  }

  renderAccountControl() {
    const el = this.elements;
    if (!el.accountControl) {
      return;
    }
    // Nothing to offer when there is no cloud: the header stays exactly as it
    // is today rather than growing a dead control.
    el.accountControl.hidden = this.state === AUTH_UNAVAILABLE || this.state === AUTH_UNKNOWN;
    const user = this.authClient?.getUser?.() || null;
    const authenticated = isAuthenticated(this.state);
    if (el.accountMenuLabel) {
      el.accountMenuLabel.textContent = authenticated ? accountLabel(user) : "アカウント";
    }
    if (el.accountMenuIdentity) {
      el.accountMenuIdentity.textContent = authenticated ? (user?.email || accountLabel(user)) : "";
      el.accountMenuIdentity.hidden = !authenticated;
    }
    if (el.accountMenuStatus) {
      el.accountMenuStatus.textContent = accountStatusText(this.state);
    }
    if (el.accountMenuLoginButton) el.accountMenuLoginButton.hidden = authenticated;
    if (el.accountMenuLogoutButton) el.accountMenuLogoutButton.hidden = !authenticated;
    if (el.accountMenuSyncNowButton) el.accountMenuSyncNowButton.hidden = !authenticated;
  }

  renderAccountFields() {
    const el = this.elements;
    if (!el.accountFieldsCard) {
      return;
    }
    // Was signed-in-only ("あなたの圃場"); the Basic-mode field-water
    // dashboard folded this list into 圃場の管理 for guests and signed-in
    // farmers alike, both reading the same fieldAnnotationController.fields
    // through accountScopedStorage, so there is no longer an authenticated
    // gate here. Hidden with zero fields instead: 圃場の管理's own
    // #basicFieldEmptyState already says "圃場はまだ登録されていません", so a
    // second, redundant "まだ圃場がありません" directly under it would just
    // be clutter for a brand-new farmer.
    const controller = this.getFieldController();
    const fields = controller?.fields || [];
    const activeId = document.getElementById("basicActiveFieldSelect")?.value || null;
    el.accountFieldsCard.hidden = fields.length === 0;

    if (el.accountFieldsEmpty) {
      el.accountFieldsEmpty.hidden = fields.length > 0;
    }
    if (!el.accountFieldsList) {
      return;
    }
    el.accountFieldsList.replaceChildren();
    fields.forEach((field) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "account-field-tile";
      button.dataset.accountFieldId = field.id;
      if (String(field.id) === String(activeId)) {
        button.classList.add("is-active");
        button.setAttribute("aria-current", "true");
      }
      const name = document.createElement("strong");
      name.className = "account-field-name";
      name.textContent = field.name || field.id;
      const area = document.createElement("span");
      area.className = "account-field-area";
      const areaM2 = Number(field.properties?.areaM2);
      area.textContent = Number.isFinite(areaM2) ? `${Math.round(areaM2).toLocaleString("ja-JP")} m²` : "面積 —";
      button.append(name, area);
      el.accountFieldsList.append(button);
    });
  }

  renderImportPrompt() {
    const el = this.elements;
    if (!el.localImportPrompt) {
      return;
    }
    const show = Boolean(this.pendingImport) && isAuthenticated(this.state);
    el.localImportPrompt.hidden = !show;
    if (show && el.localImportPromptText) {
      el.localImportPromptText.textContent = localImportPromptText(this.pendingImport.plan.count);
    }
  }

  renderSettingsPanel() {
    const el = this.elements;
    if (!el.settingsAccountPanel) {
      return;
    }
    const authenticated = isAuthenticated(this.state);
    const user = this.authClient?.getUser?.() || null;
    if (el.settingsAccountIdentity) {
      el.settingsAccountIdentity.textContent = authenticated ? (user?.email || accountLabel(user)) : "—";
    }
    if (el.settingsAccountStatus) {
      el.settingsAccountStatus.textContent = this.state === AUTH_UNAVAILABLE
        ? `${accountStatusText(this.state)}（${unconfiguredReasonText(this.config.reason)}）`
        : accountStatusText(this.state);
    }
    if (el.settingsLoginButton) el.settingsLoginButton.hidden = authenticated || this.state === AUTH_UNAVAILABLE;
    if (el.settingsLogoutButton) el.settingsLogoutButton.hidden = !authenticated;
    if (el.settingsSyncNowButton) el.settingsSyncNowButton.hidden = !authenticated;
  }

  renderSyncStatus() {
    const status = this.syncService?.status() || { status: "off", icon: "", text: "" };
    const chip = this.elements.syncStatusChip;
    if (chip) {
      const visible = status.status !== "off";
      chip.hidden = !visible;
      chip.dataset.syncStatus = status.status;
      // Icon and wording are separate elements so the phone breakpoint can
      // drop the wording and keep the ✓ / ⟳ / ! glyph, which is the whole
      // point of a subtle indicator.
      chip.replaceChildren();
      if (visible) {
        const icon = document.createElement("span");
        icon.className = "sync-status-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = status.icon;
        const label = document.createElement("span");
        label.className = "sync-status-text";
        label.textContent = status.text;
        chip.append(icon, label);
        chip.setAttribute("aria-label", `クラウド同期: ${status.text}`);
      }
    }
    if (this.elements.accountMenuSync) {
      this.elements.accountMenuSync.textContent = status.status === "off" ? "" : `${status.icon} ${status.text}`.trim();
    }
    if (this.elements.settingsSyncStatus) {
      const lastSynced = status.lastSyncedAt
        ? new Date(status.lastSyncedAt).toLocaleString("ja-JP")
        : "—";
      this.elements.settingsSyncStatus.textContent = status.status === "off"
        ? "—"
        : `${status.icon} ${status.text}（最終同期: ${lastSynced}）`;
    }
  }

  toggleAccountMenu() {
    const menu = this.elements.accountMenu;
    if (!menu) {
      return;
    }
    const open = menu.hidden;
    menu.hidden = !open;
    this.elements.accountMenuButton?.setAttribute("aria-expanded", String(open));
    if (open) {
      this.renderSyncStatus();
    }
  }

  closeAccountMenu() {
    if (this.elements.accountMenu) {
      this.elements.accountMenu.hidden = true;
    }
    this.elements.accountMenuButton?.setAttribute("aria-expanded", "false");
  }
}
