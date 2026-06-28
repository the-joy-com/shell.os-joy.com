// Shown once on launch, before the first prompt. Block-glyph (figlet
// "ANSI Shadow") on purpose — the thin line-art fonts turn to mush at small
// sizes in green-on-black, while solid blocks stay legible.
//
// Two cuts: the wide one-liner needs ~54 columns, which a phone doesn't have,
// so on narrow terminals we stack the two words (~26 cols) instead. main.ts
// picks based on the fitted terminal width.

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

export const VERSION = `v${__APP_VERSION__}`;

// The version is pinned in the bottom-right corner and shown by /help, so it
// would only be noise here.
export const TAGLINE_WIDE = `an always-on machine symbiot`;
export const TAGLINE_NARROW = `always-on symbiot`;

// Smallest column count the wide banner needs before it starts wrapping.
export const WIDE_MIN_COLS = 56;
