/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      // Strictly monochrome. Every value resolves to a CSS variable defined in
      // index.css, so dark mode is a single inversion of the token set rather
      // than a parallel set of utility classes on every element.
      // <alpha-value> is what lets bg-ink/60 and text-paper/70 exist. Without
      // it Tailwind emits no rule for those classes at all — silently, so the
      // element simply has no background and nobody finds out until a label
      // turns up the same colour as the page behind it.
      colors: {
        paper: 'rgb(var(--paper) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        'ink-2': 'rgb(var(--ink-2) / <alpha-value>)',
        'ink-3': 'rgb(var(--ink-3) / <alpha-value>)',
        rule: 'rgb(var(--rule) / <alpha-value>)',
      },
      borderRadius: {
        // Sharp by default: with no colour to carry hierarchy, crisp edges and
        // rules do that work instead.
        none: '0',
      },
      letterSpacing: {
        micro: '0.14em',
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'Liberation Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};
