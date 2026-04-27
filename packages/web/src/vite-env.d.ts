/// <reference types="vite/client" />

// Side-effect CSS imports (`import './styles.css'`) need a module declaration
// so the bundler is happy and the strict TS config doesn't reject them.
declare module '*.css';
