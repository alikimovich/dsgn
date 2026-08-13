// Ambient declarations for the untyped ESM color libraries used by apca.ts.
// Only the surface we call is declared; both are loaded via dynamic import()
// (ESM-only, and main is CJS — same constraint as the Agent SDK).

declare module 'apca-w3' {
  /** Signed APCA lightness contrast (Lc). Accepts CSS color strings or rgb arrays. */
  export function calcAPCA(
    textColor: string | number[],
    bgColor: string | number[],
    places?: number,
    round?: boolean
  ): number
  /** Font-size/weight lookup table for an Lc: index 1..9 = weight/100; values are px or 999/777/666 sentinels. */
  export function fontLookupAPCA(contrast: number, places?: number): Array<number | string>
}

declare module 'colorparsley' {
  /** Parse a CSS color → [r, g, b, a, valid, ...]. valid (index 4) is false on parse failure. */
  export function colorParsley(
    colorIn: string | number[]
  ): [number, number, number, number, boolean, string]
}
