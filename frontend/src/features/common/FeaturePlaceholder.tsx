import type { ReactNode } from 'react'

interface FeaturePlaceholderProps {
  title: string
  summary: string
  /** What Stage this workspace's real content arrives in, per docs/UI_REDESIGN.md. */
  migrationNote: string
  children?: ReactNode
}

/**
 * Stage 1 deliberately does not build a bespoke inspector for every
 * workspace (the task calls this out explicitly: "do not build dozens of
 * generic card components prematurely"). This is the one shared placeholder;
 * each feature's Inspector component replaces its slice of it as that
 * feature's migration stage lands.
 */
export function FeaturePlaceholder({ title, summary, migrationNote, children }: FeaturePlaceholderProps) {
  return (
    <div className="feature-placeholder">
      <h2 className="feature-placeholder__title">{title}</h2>
      <p className="feature-placeholder__summary">{summary}</p>
      {children}
      <p className="feature-placeholder__note">{migrationNote}</p>
    </div>
  )
}
