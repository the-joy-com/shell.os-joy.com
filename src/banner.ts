// Shown once on launch, before the first prompt. Block-glyph (figlet
// "ANSI Shadow") on purpose — the thin line-art fonts turn to mush at small
// sizes in green-on-black, while solid blocks stay legible.
//
// Three cuts, widest-that-fits: the wide one-liner (~54 cols), the stacked two
// words for a phone (~26 cols), and a plain wordmark for anything narrower than
// that. main.ts paints a cut and keeps it only if its rows land inside the box,
// stepping down otherwise — because these block and box-drawing characters can
// render wider than a plain character in a fallback font, so a width guessed
// ahead of the paint is unreliable and an overflowing banner clips.

export const BANNER_WIDE = String.raw`
████████╗██╗  ██╗███████╗         ██╗ ██████╗ ██╗   ██╗
╚══██╔══╝██║  ██║██╔════╝         ██║██╔═══██╗╚██╗ ██╔╝
   ██║   ███████║█████╗           ██║██║   ██║ ╚████╔╝
   ██║   ██╔══██║██╔══╝      ██   ██║██║   ██║  ╚██╔╝
   ██║   ██║  ██║███████╗    ╚█████╔╝╚██████╔╝   ██║
   ╚═╝   ╚═╝  ╚═╝╚══════╝     ╚════╝  ╚═════╝    ╚═╝
`;

export const BANNER_NARROW = String.raw`
████████╗██╗  ██╗███████╗
╚══██╔══╝██║  ██║██╔════╝
   ██║   ███████║█████╗
   ██║   ██╔══██║██╔══╝
   ██║   ██║  ██║███████╗
   ╚═╝   ╚═╝  ╚═╝╚══════╝

     ██╗ ██████╗ ██╗   ██╗
     ██║██╔═══██╗╚██╗ ██╔╝
     ██║██║   ██║ ╚████╔╝
██   ██║██║   ██║  ╚██╔╝
╚█████╔╝╚██████╔╝   ██║
 ╚════╝  ╚═════╝    ╚═╝
`;

// The last resort, for a surface too narrow even for the stacked cut: no block
// glyphs at all, just the name spaced out to read as a wordmark. It cannot wrap
// to mush because it is a single short line of plain characters.
export const BANNER_PLAIN = `T H E   J O Y`;

export const VERSION = `v${__APP_VERSION__}`;

// The version is pinned in the bottom-right corner and shown by /help, so it
// would only be noise here.
export const TAGLINE_WIDE = `an always-on machine symbiot`;
export const TAGLINE_NARROW = `always-on symbiot`;
