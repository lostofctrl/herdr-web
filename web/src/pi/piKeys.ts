/**
 * The exact byte sequences Pi expects for the keys Pi mode can send. Shared by
 * the Key Bar, the Side Panel's quick actions and the Chord Composer so the
 * three surfaces can never disagree about what "abort" means.
 */
export const PI_ESCAPE_KEY = "\x1B";
export const PI_ENTER_KEY = "\r";
export const PI_ALT_ENTER_KEY = "\x1B\r";
export const PI_SHIFT_TAB_KEY = "\x1B[Z";
export const PI_UP_KEY = "\x1B[A";
export const PI_DOWN_KEY = "\x1B[B";
