// unicode-emoji-json ships JSON without its declared types; Vite imports the JSON, this says what is in it.
declare module 'unicode-emoji-json' {
  const byEmoji: Record<string, { name: string; slug: string; group: string; emoji_version: string; unicode_version: string; skin_tone_support: boolean }>
  export default byEmoji
}
