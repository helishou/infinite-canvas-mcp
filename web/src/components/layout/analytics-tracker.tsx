import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

import { trackPageview } from "@/lib/analytics";
import { startLocalAnalyticsCapture, trackLocalPageview } from "@/lib/local-analytics";

// Observe SPA route changes and report page views; trackPageview is a no-op when analytics is not configured.
export function AnalyticsTracker() {
    const location = useLocation();
    const lastLocalPageviewKey = useRef<string | null>(null);

    useEffect(() => {
        trackPageview(`${location.pathname}${location.search}`);
    }, [location.pathname, location.search]);

    useEffect(() => {
        if (lastLocalPageviewKey.current === location.key) return;
        lastLocalPageviewKey.current = location.key;
        trackLocalPageview(location.pathname);
    }, [location.key, location.pathname]);

    useEffect(() => {
        startLocalAnalyticsCapture();
    }, []);

    return null;
}
