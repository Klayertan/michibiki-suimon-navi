package jp.suisuinavi.qz1bridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothSocket
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.UUID
import kotlin.concurrent.thread

class BridgeService : Service() {
    companion object {
        const val EXTRA_ADDRESS = "address"
        const val EXTRA_NAME = "name"
        private const val CHANNEL = "qz1_bridge"
        private const val PORT = 8765
        private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
    }

    @Volatile private var running = false
    @Volatile private var selectedName = "QZ1"
    private var socket: BluetoothSocket? = null
    private var server: WebSocketServer? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        createNotificationChannel()
        if (Build.VERSION.SDK_INT >= 29) startForeground(1, notification("QZ1ブリッジを起動しています"), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        else startForeground(1, notification("QZ1ブリッジを起動しています"))
        val preferences = getSharedPreferences("bridge", MODE_PRIVATE)
        val address = intent?.getStringExtra(EXTRA_ADDRESS) ?: preferences.getString(EXTRA_ADDRESS, null) ?: return START_NOT_STICKY
        selectedName = intent?.getStringExtra(EXTRA_NAME) ?: preferences.getString(EXTRA_NAME, "QZ1") ?: "QZ1"
        preferences.edit().putString(EXTRA_ADDRESS, address).putString(EXTRA_NAME, selectedName).apply()
        if (!running) {
            running = true
            startWebSocketServer()
            thread(name = "qz1-rfcomm") { connectLoop(address) }
        }
        return START_STICKY
    }

    private fun startWebSocketServer() {
        server = object : WebSocketServer(InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT)) {
            override fun onOpen(conn: WebSocket, handshake: ClientHandshake) { sendStatus(conn, if (socket?.isConnected == true) "connected" else "disconnected") }
            override fun onClose(conn: WebSocket, code: Int, reason: String, remote: Boolean) {}
            override fun onMessage(conn: WebSocket, message: String) {}
            override fun onError(conn: WebSocket?, ex: Exception) {}
            override fun onStart() {}
        }.also { it.start() }
    }

    private fun connectLoop(address: String) {
        while (running) {
            try {
                val device = BluetoothAdapter.getDefaultAdapter().getRemoteDevice(address)
                val current = device.createRfcommSocketToServiceRecord(SPP_UUID)
                socket = current
                current.connect()
                broadcastStatus("connected")
                updateNotification("QZ1接続中: $selectedName")
                BufferedReader(InputStreamReader(current.inputStream, Charsets.US_ASCII)).use { reader ->
                    while (running && current.isConnected) {
                        val line = reader.readLine() ?: break
                        if (line.isNotBlank()) server?.connections?.forEach { client -> if (client.isOpen) client.send("$line\r\n") }
                    }
                }
            } catch (_: Exception) {
                if (running) { broadcastStatus("disconnected"); updateNotification("QZ1未接続: $selectedName"); Thread.sleep(1500) }
            } finally { try { socket?.close() } catch (_: Exception) {}; socket = null }
        }
    }

    private fun sendStatus(client: WebSocket, state: String) {
        client.send("{\"type\":\"status\",\"state\":\"$state\",\"deviceName\":\"${selectedName.replace("\"", "") }\"}")
    }

    private fun broadcastStatus(state: String) { server?.connections?.forEach { client -> if (client.isOpen) sendStatus(client, state) } }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= 26) getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL, "QZ1 Bridge", NotificationManager.IMPORTANCE_LOW))
    }

    private fun notification(text: String): Notification = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL).setContentTitle("SuiSui QZ1 Bridge").setContentText(text).setSmallIcon(android.R.drawable.stat_sys_data_bluetooth).build() else Notification.Builder(this).setContentTitle("SuiSui QZ1 Bridge").setContentText(text).setSmallIcon(android.R.drawable.stat_sys_data_bluetooth).build()
    private fun updateNotification(text: String) { getSystemService(NotificationManager::class.java).notify(1, notification(text)) }

    override fun onDestroy() {
        running = false
        try { socket?.close() } catch (_: Exception) {}
        server?.stop(1000)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
