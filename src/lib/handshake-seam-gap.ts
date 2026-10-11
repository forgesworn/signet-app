/** Between the two screens, top to top, each phone hides a strip: its status
 * bar and top bezel. Assumed 80 dp each: measured, it is 40 to 50 dp of status
 * bar and 2 to 3 mm of bezel on the phones it was tried on, but by eye the
 * lines joined better with a wider allowance. Each half starts that far beyond
 * the seam, so the lines carry on across the gap and the eye joins them. A
 * phone whose strip differs can set its own, in millimetres (Settings). */
export const SEAM_GAP_DP = 80;
/** CSS px are dp in the Android WebView, and a dp is 1/160 inch. */
export const DP_PER_MM = 160 / 25.4;
export const SEAM_GAP_DEFAULT_MM = SEAM_GAP_DP / DP_PER_MM;
export const SEAM_GAP_MAX_MM = 30;
export const mmToDp = (mm: number): number => mm * DP_PER_MM;
/** A distance the user may set: finite, 0 to 30 mm. Anything else is ignored. */
export const validSeamGapMm = (mm: unknown): mm is number => typeof mm === 'number' && Number.isFinite(mm) && mm >= 0 && mm <= SEAM_GAP_MAX_MM;
/** The strip to allow on this phone, in dp: its own setting, else the default. */
export const seamGapDp = (mm?: number): number => validSeamGapMm(mm) ? mmToDp(mm) : SEAM_GAP_DP;
