import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LoadStateBadge } from '../components/LoadStateBadge';

describe('LoadStateBadge', () => {
  it('renders mixed when states are mixed without partial failure', () => {
    render(<LoadStateBadge trackStates={['loading', 'empty']} />);
    expect(screen.getByText('mixed')).toBeDefined();
  });

  it('renders loading when all tracks are loading', () => {
    render(<LoadStateBadge trackStates={['loading', 'loading']} />);
    expect(screen.getByText('loading')).toBeDefined();
  });

  it('renders ready when all tracks are ready', () => {
    render(<LoadStateBadge trackStates={['ready', 'ready']} />);
    expect(screen.getByText('ready')).toBeDefined();
  });

  it('renders empty when all tracks are empty', () => {
    render(<LoadStateBadge trackStates={['empty', 'empty']} />);
    expect(screen.getByText('empty')).toBeDefined();
  });

  it('renders partial failure text when mixed has ready and failed states', () => {
    render(<LoadStateBadge trackStates={['ready', 'failed']} />);
    expect(screen.getByText('mixed (partial failure)')).toBeDefined();
  });
});
