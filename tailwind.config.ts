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
        paper: "#f7f3ea",
        ink: "#18314f",
        coral: "#dc6d57",
        amber: "#c78a24",
        mist: "#d8ddd4",
        night: "#13191f"
      },
      boxShadow: {
        float: "0 22px 50px rgba(19, 25, 31, 0.18)"
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "sans-serif"
        ],
        serif: [
          "Iowan Old Style",
          "Palatino Linotype",
          "Book Antiqua",
          "serif"
        ]
      }
    }
  },
  plugins: []
};

export default config;
