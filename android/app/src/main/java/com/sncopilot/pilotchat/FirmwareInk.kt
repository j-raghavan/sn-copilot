package com.sncopilot.pilotchat

import android.content.Context
import android.os.IBinder
import android.os.Parcel
import android.util.Log

/**
 * Supernote's firmware pen ink (FR5/NFR2): the pen daemon behind the
 * `service_myservice` binder paints stylus ink straight onto the e-ink
 * controller's overlay, at the latency of Supernote's own notes. The canvas
 * claims it for the pencil; [LiveInk] decides when.
 *
 * Ported from inkread's SupernoteInk, proven from a sideloaded app on this
 * device. That reproduces the documented binder contract (service name,
 * interface token, transaction codes, parcel layout) from plateaukao's AGPL-3
 * reimplementation of Ratta's HandWriteClient; no Ratta code is copied. The
 * note sends the same transactions: it turns ink off over the whole screen
 * when a plugin opens, and back on with its own areas when the plugin closes.
 * Reflection and binder throughout, and nothing here ever throws.
 */
internal class FirmwareInk(
    private val context: Context,
    private val appName: String,
) {
    private var cached: IBinder? = null

    // The firmware only takes clears and releases from the app that claimed the pen.
    private var claimed = false

    /** Claims the pen for this window, inking everywhere with the canvas's pencil; safe to repeat. False without the firmware service. */
    fun setup(): Boolean {
        if (binder() == null) return false
        send(TX_WRITE_APP_INFO) { parcel ->
            parcel.writeInt(0)
            parcel.writeInt(0)
        }
        enableFullUiAuto(true)
        // No disabled areas.
        send(TX_DISABLE_AREA) { parcel -> parcel.writeInt(0) }
        sendPen(FirmwarePen.CANVAS)
        claimed = true
        return true
    }

    /** Wipes the firmware ink overlay. */
    fun clearAll() {
        if (!claimed) return
        send(TX_DRAW_BUFFER) { parcel ->
            parcel.writeInt(CLEAR_ALL)
            parcel.writeInt(0)
        }
    }

    /** Firmware ink on or off over the whole window: HandWriteClient's one sentinel rect `[0, 0, edge, edge, 0]`. */
    fun setWritable(enable: Boolean) {
        if (!claimed) return
        val edge = if (enable) WRITABLE_ON_EDGE else WRITABLE_OFF_EDGE
        send(TX_DISABLE_AREA) { parcel ->
            parcel.writeInt(1)
            for (value in intArrayOf(0, 0, edge, edge, 0)) parcel.writeInt(value)
        }
    }

    /**
     * Gives the pen back to the note: clears the overlay, sets the note's own
     * [pen] back when it is known, and turns ink back on, as the note had it.
     * When a plugin closes, the note restores only its disabled areas, never
     * ink itself (it never turned ink off) or its pen (it sends that only when
     * a tool is tapped), so a pen left off here would stop writing in the note,
     * and one left as the canvas's would write with the canvas's pencil.
     */
    fun teardown(pen: FirmwarePen?) {
        if (!claimed) return
        clearAll()
        pen?.let(::sendPen)
        setWritable(true)
        enableFullUiAuto(false)
        claimed = false
    }

    private fun sendPen(pen: FirmwarePen) {
        send(TX_PEN) { parcel ->
            parcel.writeInt(pen.type)
            parcel.writeInt(pen.size)
            parcel.writeInt(pen.color)
        }
    }

    /** Resolves (and caches) the firmware binder through the hidden ServiceManager.getService. */
    private fun binder(): IBinder? {
        cached?.takeIf { it.isBinderAlive }?.let { return it }
        cached =
            runCatching {
                val getService = Class.forName("android.os.ServiceManager").getMethod("getService", String::class.java)
                SERVICE_NAMES.firstNotNullOfOrNull { name -> getService.invoke(null, name) as? IBinder }
            }.onFailure { Log.w(TAG, "firmware ink service unavailable: $it") }.getOrNull()
        return cached
    }

    /** One transaction: interface token and app-name preamble, then the per-call ints from [write]. */
    private fun send(
        code: Int,
        write: (Parcel) -> Unit,
    ) {
        val binder = binder() ?: return
        val data = Parcel.obtain()
        val reply = Parcel.obtain()
        runCatching {
            data.writeInterfaceToken(IFACE_TOKEN)
            data.writeString(appName)
            write(data)
            binder.transact(code, data, reply, 0)
        }.onFailure { Log.w(TAG, "firmware ink transaction $code failed: $it") }
        data.recycle()
        reply.recycle()
    }

    /** getSystemService("eink").enableFullUiAuto(enable); SELinux may make it a no-op for a plugin, which is harmless. */
    private fun enableFullUiAuto(enable: Boolean) {
        runCatching {
            val eink = context.getSystemService("eink") ?: return
            eink.javaClass.getMethod("enableFullUiAuto", Boolean::class.javaPrimitiveType).invoke(eink, enable)
        }.onFailure { Log.w(TAG, "enableFullUiAuto($enable) failed: $it") }
    }

    private companion object {
        const val TAG = "SnCopilotPilotChatInk"
        val SERVICE_NAMES = arrayOf("service_myservice", "service.myservice")
        const val IFACE_TOKEN = "android.demo.IMyService"

        const val TX_WRITE_APP_INFO = 0
        const val TX_DISABLE_AREA = 1
        const val TX_PEN = 2
        const val TX_DRAW_BUFFER = 6

        const val CLEAR_ALL = 255

        // HandWriteClient's sentinel rect edges: ink on everywhere, and off everywhere.
        const val WRITABLE_ON_EDGE = 18888
        const val WRITABLE_OFF_EDGE = 19999
    }
}
