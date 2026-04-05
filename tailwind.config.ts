import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        // New dark palette
        void: "#08090a",
        pit: "#0c0d0f",
        cave: "#111214",
        shell: "#181a1d",
        rim: "#22262b",
        wire: "#2e3338",
        fog: "#4a5058",
        smoke: "#787068",
        ash: "#9da4ac",
        linen: "#d4cfc5",
        ghost: "#edeae3",
        gold: "#e8a030",
        ember: "#e05848",
        sea: "#3aafa9",
        steel: "#7fa7d0",
        // Legacy names (kept for annotation system compatibility)
        paper: "#f7f3ea",
        ink: "#18314f",
        coral: "#e05848",
        amber: "#e8a030",
        mist: "#d8ddd4",
        night: "#08090a"
      },
      boxShadow: {
        float: "0 24px 60px rgba(0, 0, 0, 0.7)",
        lift: "0 8px 24px rgba(0, 0, 0, 0.45)",
        glow: "0 0 40px rgba(232, 160, 48, 0.14)",
        "glow-sm": "0 0 20px rgba(232, 160, 48, 0.08)",
        "glow-ember": "0 0 20px rgba(224, 88, 72, 0.12)"
      },
      fontFamily: {
        display: ["var(--font-display)", "Georgia", "serif"],
        mono: ["var(--font-mono)", "Fira Code", "Consolas", "monospace"],
        sans: ["var(--font-mono)", "ui-monospace", "monospace"],
        serif: ["var(--font-display)", "Georgia", "serif"]
      }
    }
  },
  plugins: []
};

export default config;
