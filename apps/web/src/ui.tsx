const iconPaths = {
  home: "M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z",
  document: "M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6",
  drafts: "M8 5H5v16h13v-3 M9 3h10v13H9z M12 7h4 M12 11h4",
  repeat: "M4 10V8a3 3 0 0 1 3-3h13m-4-3 4 3-4 3 M20 14v2a3 3 0 0 1-3 3H4m4-3-4 3 4 3",
  clients: "M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2 M9.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M21 21v-2a4 4 0 0 0-3-4 M17 3.3a4 4 0 0 1 0 7.4",
  services: "M4 7h16v14H4z M9 7V4h6v3 M4 12a21 21 0 0 0 16 0 M10 14h4",
  building: "M4 21h16 M6 21V3h12v18 M9 7h1m4 0h1 M9 11h1m4 0h1 M9 15h1m4 0h1 M10 21v-3h4v3",
  report: "M4 4v16h16 M8 16v-4 M13 16V8 M18 16V5",
  shield: "M12 22c5-2 8-5.5 8-10V6l-8-3-8 3v6c0 4.5 3 8 8 10Z M9 12l2 2 4-4",
  key: "M15.5 14a5.5 5.5 0 1 0-5.5-5.5 5.5 5.5 0 0 0 5.5 5.5Z M11.6 12.4 3 21v-4l3-3h3v-3",
  arrow: "M4 12h15m-6-6 6 6-6 6",
  plus: "M12 5v14M5 12h14",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "m6 6 12 12M18 6 6 18",
  logout: "M10 4H4v16h6 M9 12h12m-4-4 4 4-4 4",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z M12 7v5l3 2",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4",
  download: "M12 3v12m-5-5 5 5 5-5 M4 16v5h16v-5",
  external: "M14 3h7v7m0-7L10 14 M10 3H3v18h18v-7",
  search: "M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15Z m5.5-2 5 5",
  wallet: "M20 8V5H4a2 2 0 0 1 0-4h14v4 M4 5H2v16h20V8H4 M22 12h-6v5h6 M18 14.5h.01",
  calendar: "M4 5h16v16H4z M8 2v6m8-6v6M4 11h16",
  check: "m5 12 4 4L19 6",
  message: "M21 11.5a8.5 8.5 0 0 1-12.5 7.5L3 21l2-5.5A8.5 8.5 0 1 1 21 11.5Z M8 10h8 M8 14h5",
  phone: "M6 3H3c0 10 8 18 18 18v-3l-5-3-3 3a15 15 0 0 1-7-7l3-3-3-5Z",
  email: "M3 5h18v14H3z m0 0 9 8 9-8",
};

export type IconName = keyof typeof iconPaths;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={iconPaths[name]} />
    </svg>
  );
}

export function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark"><Icon name="document" /></span>
      <span>Fiscal <span className="brand-accent">Floow</span></span>
    </span>
  );
}

export function FiscalIllustration() {
  return (
    <svg className="fiscal-illustration" viewBox="0 0 300 224" fill="none" aria-hidden="true" focusable="false">
      <circle cx="163" cy="110" r="99" stroke="#9BBEFF" strokeOpacity=".16" />
      <circle cx="163" cy="110" r="77" stroke="#9BBEFF" strokeOpacity=".21" />
      <circle cx="163" cy="110" r="54" stroke="#9BBEFF" strokeOpacity=".24" />
      <path d="M48 105h230M163 12v200" stroke="#9BBEFF" strokeOpacity=".16" strokeDasharray="4 6" />
      <rect x="103" y="46" width="118" height="151" rx="17" transform="rotate(10 103 46)" fill="#75A4FF" fillOpacity=".26" stroke="#AEC9FF" strokeOpacity=".45" />
      <rect x="85" y="27" width="119" height="153" rx="16" transform="rotate(-8 85 27)" fill="#F0F5FF" />
      <g transform="rotate(-8 85 27)">
        <rect x="101" y="43" width="32" height="32" rx="9" fill="#DDEAFF" />
        <path d="M113 52h6l3 3v11h-10V52h1Zm5 0v4h4m-7 4h4m-4 3h4" stroke="#245CC9" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M144 55h43m-43 10h28M103 91h84m-84 12h71m-71 12h84m-84 12h56" stroke="#A6BFEE" strokeWidth="4" strokeLinecap="round" />
        <path d="M103 143h84" stroke="#B9CBEB" strokeDasharray="3 4" />
        <path d="M103 159h38m20 0h26" stroke="#4475D4" strokeWidth="4" strokeLinecap="round" />
      </g>
      <circle cx="217" cy="159" r="29" fill="#102B58" />
      <circle cx="217" cy="159" r="23" fill="#8AE6C8" />
      <path d="m207 159 7 7 13-14" stroke="#125443" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M249 39v15m-7-7h14M67 157v16m-8-8h16" stroke="#8AE6C8" strokeWidth="2" strokeLinecap="round" />
      <circle cx="60" cy="76" r="4" fill="#A6C2FF" />
      <circle cx="265" cy="123" r="3" fill="#A6C2FF" />
    </svg>
  );
}
