export function getNextGalleryIndex(currentIndex: number, imageCount: number): number {
  if (imageCount <= 1) return 0;
  return (currentIndex + 1) % imageCount;
}

export function getSwipeDirection(horizontalDelta: number): -1 | 1 | null {
  if (Math.abs(horizontalDelta) < 40) return null;
  return horizontalDelta > 0 ? 1 : -1;
}
