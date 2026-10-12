package jp.suisuinavi.qz1bridge

import android.Manifest
import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

class MainActivity : Activity() {
    private lateinit var list: LinearLayout
    private val requestCode = 42

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 48, 32, 24) }
        setContentView(list)
        render()
    }

    private fun render() {
        list.removeAllViews()
        list.addView(TextView(this).apply { text = "QZ1 Bluetooth SPP Bridge\nPaired QZ1 device → local WebSocket 127.0.0.1:8765"; textSize = 18f })
        if (Build.VERSION.SDK_INT >= 31 && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            list.addView(Button(this).apply { text = "Bluetooth接続権限を許可"; setOnClickListener { requestPermissions(arrayOf(Manifest.permission.BLUETOOTH_CONNECT), requestCode) } })
            return
        }
        val adapter = BluetoothAdapter.getDefaultAdapter()
        if (adapter == null || !adapter.isEnabled) {
            list.addView(TextView(this).apply { text = "Bluetoothを有効にして、Android設定でQZ1をペアリングしてください。" })
            return
        }
        list.addView(TextView(this).apply { text = "ペア設定済み端末を選択してください。QZ1が一覧にない場合はAndroid設定からペアリングしてください。" })
        adapter.bondedDevices.orEmpty().forEach { device ->
            list.addView(Button(this).apply {
                text = "接続: ${device.name ?: "Bluetooth device"}"
                setOnClickListener {
                    val service = Intent(this@MainActivity, BridgeService::class.java).putExtra(BridgeService.EXTRA_ADDRESS, device.address).putExtra(BridgeService.EXTRA_NAME, device.name ?: "QZ1")
                    if (Build.VERSION.SDK_INT >= 26) startForegroundService(service) else startService(service)
                    list.addView(TextView(this@MainActivity).apply { text = "接続を開始しました。ChromeでSuiSuiNaviを開いて「QZ1に接続」を押してください。" })
                }
            })
        }
        list.addView(Button(this).apply { text = "ブリッジ停止"; setOnClickListener { stopService(Intent(this@MainActivity, BridgeService::class.java)) } })
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == this.requestCode) render()
    }
}
