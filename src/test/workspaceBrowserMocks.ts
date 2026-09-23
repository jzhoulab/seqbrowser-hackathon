import { vi } from 'vitest';

/** jsdom lacks media queries and native dialog lifecycle; real focus is checked in-browser. */
export function mockWorkspaceBrowser() {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  HTMLDialogElement.prototype.show = function () { this.open = true; };
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
}
