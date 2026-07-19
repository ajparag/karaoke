// =============================================================================
// NotFound.tsx — 404 page
// =============================================================================
// CHANGELOG
// v1 — Original. Used <a href="/"> causing full page reload instead of SPA
//      navigation. Already fixed with Link in the uploaded version.
// v2 — CURRENT: UI polish to match new theme. Logic unchanged.
// =============================================================================

import { useEffect } from 'react';
import { useLocation, Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Mic, Home } from 'lucide-react';

export default function NotFound() {
  const location = useLocation();

  useEffect(() => {
    console.error('[404] Non-existent route accessed:', location.pathname);
  }, [location.pathname]);

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4 text-center">
      <div className="w-16 h-16 rounded-2xl gradient-primary flex items-center justify-center mb-6">
        <Mic className="w-8 h-8 text-primary-foreground" />
      </div>
      <h1 className="text-6xl font-bold text-gradient mb-2">404</h1>
      <p className="text-lg text-muted-foreground mb-6">
        This page doesn't exist — but the stage is always open.
      </p>
      <Link to="/">
        <Button className="gradient-primary text-primary-foreground gap-2">
          <Home className="w-4 h-4" /> Back to home
        </Button>
      </Link>
    </div>
  );
}
