// Solo games, loaded on demand.
import type { ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Spinner } from '../ui';

const SOLO: Record<string, () => Promise<{ default: ComponentType }>> = {
  codeword: () => import('../games/Codeword'),
  fusion: () => import('../games/Fusion'),
};

export function Solo({ game }: { game: string }) {
  const [Game, setGame] = useState<ComponentType | null>(null);
  useEffect(() => {
    SOLO[game]().then((m) => setGame(() => m.default));
  }, [game]);
  return Game ? <Game /> : <div class="center-screen"><Spinner /></div>;
}
