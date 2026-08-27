export function getBackNavigationTarget(fallbackPath = "/lobby") {
  if (typeof window === "undefined") {
    return fallbackPath;
  }

  const historyState = window.history.state || {};
  const currentIndex = typeof historyState.idx === "number" ? historyState.idx : 0;

  if (currentIndex > 0) {
    return "back";
  }

  if (document.referrer) {
    try {
      const ref = new URL(document.referrer);
      if (ref.origin === window.location.origin) {
        return `${ref.pathname}${ref.search}${ref.hash}`;
      }
    } catch {
      // Ignore invalid referrer values and fall back below.
    }
  }

  return fallbackPath;
}

export function navigateBack(navigate, fallbackPath = "/lobby") {
  const target = getBackNavigationTarget(fallbackPath);

  if (target === "back") {
    navigate(-1);
    return true;
  }

  navigate(target);
  return false;
}
