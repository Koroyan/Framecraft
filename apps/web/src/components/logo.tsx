export function Logo({ small }: { small?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" className={small ? 'size-6' : 'size-7'} aria-hidden>
        <defs>
          <linearGradient id="fc-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#b9b3ff" />
            <stop offset="1" stopColor="#6352f0" />
          </linearGradient>
        </defs>
        <rect x="2" y="2" width="28" height="28" rx="9" fill="url(#fc-g)" />
        <path d="M11 9.5h10.5M11 9.5v13M11 16h7.5" stroke="#090b13" strokeWidth="2.6" strokeLinecap="round" />
        <circle cx="22" cy="21.5" r="2.2" fill="#090b13" />
      </svg>
      {!small && <span className="text-[17px] font-semibold tracking-tight text-white">Framecraft</span>}
    </span>
  );
}
