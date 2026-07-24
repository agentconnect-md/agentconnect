// Stylesheet side-effect imports are resolved by the Next.js bundler, not by tsc.
// TypeScript 6 requires an ambient declaration for them (TS2882).
declare module '*.css'
