/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      // Strictly monochrome. Every value resolves to a CSS variable defined in
      // index.css, so dark mode is a single inversion of the token set rather
      // than a parallel set of utility classes on every element.
      colors: {
        paper: 'var(--paper)',
        surface: 'var(--surface)',
        ink: 'var(--ink)',
        'ink-2': 'var(--ink-2)',
        'ink-3': 'var(--ink-3)',
        rule: 'var(--rule)',
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
