"use client";

import { useState, useEffect, useRef, useCallback } from "react";

const CORRECT_HASH = "annotate!";

/* Floating annotation marks for atmosphere */
function FloatingMarks() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden opacity-[0.035]">
      {/* Scattered underline strokes */}
      <svg className="absolute top-[18%] left-[12%] w-32 floating-mark-1" viewBox="0 0 120 8" fill="none">
        <path d="M2 5 Q30 2 60 5 Q90 8 118 4" stroke="#e8a030" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <svg className="absolute top-[35%] right-[8%] w-40 floating-mark-2" viewBox="0 0 160 8" fill="none">
        <path d="M2 3 Q40 7 80 3 Q120 0 158 5" stroke="#e8a030" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <svg className="absolute bottom-[28%] left-[6%] w-28 floating-mark-3" viewBox="0 0 100 8" fill="none">
        <path d="M2 4 Q25 1 50 5 Q75 8 98 3" stroke="#e8a030" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      <svg className="absolute top-[55%] right-[15%] w-24 floating-mark-4" viewBox="0 0 90 8" fill="none">
        <path d="M2 5 Q22 2 45 6 Q68 8 88 3" stroke="#e8a030" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      <svg className="absolute bottom-[15%] right-[25%] w-36 floating-mark-5" viewBox="0 0 140 8" fill="none">
        <path d="M2 3 Q35 6 70 3 Q105 1 138 5" stroke="#e8a030" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <svg className="absolute top-[72%] left-[20%] w-20 floating-mark-6" viewBox="0 0 80 8" fill="none">
        <path d="M2 5 Q20 2 40 5 Q60 7 78 4" stroke="#e8a030" strokeWidth="2" strokeLinecap="round" />
      </svg>
      {/* Sparkle stars */}
      <svg className="absolute top-[25%] right-[30%] w-4 h-4 floating-mark-3" viewBox="-14 -14 28 28" fill="none">
        <path d="M0 -14 L3 -4 L14 0 L3 4 L0 14 L-3 4 L-14 0 L-3 -4 Z" fill="#e8a030" opacity="0.7" />
      </svg>
      <svg className="absolute bottom-[35%] left-[15%] w-3 h-3 floating-mark-5" viewBox="-14 -14 28 28" fill="none">
        <path d="M0 -14 L3 -4 L14 0 L3 4 L0 14 L-3 4 L-14 0 L-3 -4 Z" fill="#e8a030" opacity="0.5" />
      </svg>
    </div>
  );
}

/* Scan line effect */
function ScanLine() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="scan-line absolute left-0 right-0 h-px bg-gradient-to-r from-transparent via-gold/20 to-transparent" />
    </div>
  );
}

export function PasswordGate({ children }: { children: React.ReactNode }) {
  const [authorized, setAuthorized] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [shaking, setShaking] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [typedChars, setTypedChars] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (password === CORRECT_HASH) {
        setError(false);
        setUnlocking(true);
        setTimeout(() => {
          setAuthorized(true);
        }, 900);
      } else {
        setError(true);
        setShaking(true);
        setTimeout(() => setShaking(false), 500);
        setTimeout(() => {
          setPassword("");
          setTypedChars(0);
          inputRef.current?.focus();
        }, 600);
      }
    },
    [password]
  );

  if (authorized) return <>{children}</>;

  return (
    <div
      className={`fixed inset-0 z-[9999] flex items-center justify-center dot-grid transition-all duration-700 ${
        unlocking ? "gate-unlock" : ""
      }`}
      style={{ background: "#08090a" }}
    >
      <FloatingMarks />
      <ScanLine />

      {/* Vignette */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at center, transparent 40%, rgba(8,9,10,0.85) 100%)",
        }}
      />

      <div
        className={`relative z-10 flex w-full max-w-sm flex-col items-center px-6 ${
          unlocking ? "gate-content-unlock" : ""
        }`}
      >
        {/* Logo */}
        <div className="reveal reveal-1 mb-8">
          <div className="relative">
            <img
              src="/logo.svg"
              alt="Annotagent"
              className="h-16 w-16 drop-shadow-lg"
            />
            {/* Subtle pulse ring around logo */}
            <div className="absolute -inset-3 rounded-2xl border border-gold/10 gate-pulse" />
          </div>
        </div>

        {/* Title */}
        <h1 className="reveal reveal-2 mb-1 font-display text-2xl tracking-wide text-ghost">
          Annotagent
        </h1>
        <p className="reveal reveal-2 mb-8 text-[11px] uppercase tracking-[0.35em] text-smoke">
          Restricted Access
        </p>

        {/* Terminal-style access line */}
        <div className="reveal reveal-3 mb-6 w-full rounded-lg border border-rim/50 bg-cave/60 px-4 py-3">
          <div className="flex items-center gap-2 text-[11px] text-fog">
            <span className="text-gold/60">$</span>
            <span className="text-smoke">access-request</span>
            <span className="text-wire">--vault</span>
            <span className="text-gold/40">research-annotations</span>
          </div>
          <div className="mt-1.5 flex items-center gap-2 text-[11px]">
            <span className="text-gold/60">&gt;</span>
            <span className="text-ash">
              awaiting credentials
              <span className="cursor-blink" />
            </span>
          </div>
        </div>

        {/* Password form */}
        <form
          onSubmit={handleSubmit}
          className={`reveal reveal-4 w-full ${shaking ? "gate-shake" : ""}`}
        >
          <label
            htmlFor="gate-pw"
            className="mb-2 block text-[10px] uppercase tracking-[0.4em] text-fog"
          >
            Enter passphrase
          </label>
          <div className="relative">
            <input
              ref={inputRef}
              id="gate-pw"
              type="password"
              autoFocus
              autoComplete="off"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setTypedChars(e.target.value.length);
                if (error) setError(false);
              }}
              className={`glow-gold w-full rounded-lg border bg-pit/80 px-4 py-3 text-sm text-linen placeholder:text-wire outline-none transition-colors duration-200 ${
                error
                  ? "border-ember/60 shadow-glow-ember"
                  : "border-rim/70 focus:border-gold/40"
              }`}
              placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;"
            />
            {/* Character counter dots */}
            <div className="absolute right-3 top-1/2 flex -translate-y-1/2 gap-0.5">
              {Array.from({ length: Math.min(typedChars, 12) }).map((_, i) => (
                <div
                  key={i}
                  className="h-1 w-1 rounded-full bg-gold/50 gate-dot-enter"
                  style={{ animationDelay: `${i * 30}ms` }}
                />
              ))}
            </div>
          </div>

          {/* Error message */}
          <div
            className={`mt-2 overflow-hidden transition-all duration-300 ${
              error
                ? "max-h-8 opacity-100"
                : "max-h-0 opacity-0"
            }`}
          >
            <p className="text-[11px] text-ember/80">
              <span className="text-ember/50">err:</span> invalid credentials
            </p>
          </div>

          <button
            type="submit"
            className="mt-4 w-full rounded-lg border border-gold/20 bg-gold/[0.07] px-4 py-2.5 text-[11px] uppercase tracking-[0.3em] text-gold transition-all duration-200 hover:border-gold/40 hover:bg-gold/[0.12] hover:shadow-glow-sm active:scale-[0.985]"
          >
            Authenticate
          </button>
        </form>

        {/* Bottom decoration */}
        <div className="reveal reveal-5 mt-10 flex items-center gap-3 text-[10px] text-wire">
          <div className="h-px w-8 bg-rim/40" />
          <span className="uppercase tracking-[0.5em]">Classified</span>
          <div className="h-px w-8 bg-rim/40" />
        </div>
      </div>
    </div>
  );
}
