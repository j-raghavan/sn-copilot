package com.sncopilot.pilotchat

/**
 * A pen as Supernote's firmware ink takes it ([FirmwareInk]'s pen
 * transaction): nib [type], [size] and [color], in the firmware's own codes.
 *
 * The canvas's pencil sets the firmware to [CANVAS], and the note never sends
 * its own pen again by itself (only when one of its tools is tapped), so the
 * canvas sets the note's pen back as it closes ([ofNotePen]). The note's lasso
 * has no firmware code known outside the note, so after the pencil a lasso
 * still draws with the pen set back until the lasso tool is tapped again.
 */
internal data class FirmwarePen(
    val type: Int,
    val size: Int,
    val color: Int,
) {
    companion object {
        // Firmware nib and colour codes, as the note sends them (its calligraphy pen goes out as type 15).
        private const val NEEDLE = 10
        private const val MARKER = 11
        private const val CALLIGRAPHY = 15
        private const val INK = 16
        private const val BLACK = 0
        private const val DARK_GRAY = -101
        private const val GRAY = -102
        private const val LIGHT_GRAY = 254
        private const val CANVAS_SIZE = 1000

        // The SDK's codes (sn-plugin-lib's PenInfo): pressure pen, fineliner, marker, calligraphy; its three greys.
        private const val SDK_PRESSURE = 1
        private const val SDK_FINELINER = 10
        private const val SDK_MARKER = 11
        private const val SDK_CALLIGRAPHY = 14
        private const val SDK_DARK_GRAY = 0x9D
        private const val SDK_LIGHT_GRAY = 0xC9
        private const val SDK_WHITE = 0xFE

        // A firmware code maps to itself: this device's host reports those (calligraphy as 15, not the SDK's 14).
        private val TYPES =
            mapOf(
                SDK_PRESSURE to INK,
                SDK_FINELINER to NEEDLE,
                SDK_MARKER to MARKER,
                SDK_CALLIGRAPHY to CALLIGRAPHY,
                CALLIGRAPHY to CALLIGRAPHY,
                INK to INK,
            )
        private val COLORS =
            mapOf(
                BLACK to BLACK,
                SDK_DARK_GRAY to DARK_GRAY,
                SDK_LIGHT_GRAY to GRAY,
                SDK_WHITE to LIGHT_GRAY,
                DARK_GRAY to DARK_GRAY,
                GRAY to GRAY,
            )

        /** The canvas's pencil: the firmware's needle, black, at the size its strokes are drawn to match. */
        val CANVAS = FirmwarePen(NEEDLE, CANVAS_SIZE, BLACK)

        /**
         * The firmware pen for the note's pen as the SDK's getPenInfo reports it,
         * or null for a nib the firmware has no code for. An unknown colour is
         * black. The width passes through as it is, in the same unit: on the
         * device the note's calligraphy pen reports width 2400, and set back as
         * 2400 it writes as before. No width at all is the canvas's.
         */
        fun ofNotePen(
            type: Int,
            width: Int,
            color: Int,
        ): FirmwarePen? {
            val nib = TYPES[type] ?: return null
            return FirmwarePen(nib, if (width > 0) width else CANVAS_SIZE, COLORS[color] ?: BLACK)
        }
    }
}
