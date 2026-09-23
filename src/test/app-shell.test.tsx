import { SITE_PROFILE } from '../features/site/profile';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { mockWorkspaceBrowser } from './workspaceBrowserMocks';

vi.mock('../components/RulerCanvas', () => ({
  RulerCanvas: () => null,
}));

vi.mock('../components/TrackList', () => ({
  TrackList: () => null,
}));

vi.mock('../components/BrushNavigator', () => ({
  BrushNavigator: () => null,
}));

import App from '../App';

describe('App shell', () => {
  it('renders the main heading', () => {
    mockWorkspaceBrowser();
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );

    render(<App />);
    expect(screen.getByRole('heading', { name: SITE_PROFILE.brand.name })).toBeDefined();
  });
});
