"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type PointerEvent, type TouchEvent } from "react";
import {
  getNextGalleryIndex,
  getSwipeDirection,
} from "./product-image-gallery-utils";

export interface ProductGalleryImage {
  url: string;
  altText: string;
}

function isLocalProductImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "localhost" &&
      url.port === "4000" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/local-product-images\/[0-9a-f-]{36}\.webp$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export default function ProductImageGallery({
  images,
  title,
  sizes,
}: {
  images: ProductGalleryImage[];
  title: string;
  sizes: string;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const touchStartX = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const clickResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const image = images[activeIndex];

  function stopGallery(reset: boolean) {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (reset) setActiveIndex(0);
  }

  function handlePointerEnter(event: PointerEvent<HTMLAnchorElement>) {
    if (event.pointerType !== "mouse" || images.length < 2) return;
    stopGallery(false);
    intervalRef.current = setInterval(() => {
      setActiveIndex((index) => getNextGalleryIndex(index, images.length));
    }, 800);
  }

  function handleTouchStart(event: TouchEvent<HTMLAnchorElement>) {
    touchStartX.current = event.touches[0]?.clientX ?? null;
  }

  function handleTouchEnd(event: TouchEvent<HTMLAnchorElement>) {
    const startX = touchStartX.current;
    touchStartX.current = null;
    const endX = event.changedTouches[0]?.clientX;
    if (startX === null || endX === undefined || images.length < 2) return;

    const direction = getSwipeDirection(startX - endX);
    if (direction === null) return;

    setActiveIndex((index) =>
      (index + direction + images.length) % images.length,
    );
    suppressClick.current = true;
    if (clickResetRef.current !== null) clearTimeout(clickResetRef.current);
    clickResetRef.current = setTimeout(() => {
      suppressClick.current = false;
      clickResetRef.current = null;
    }, 500);
  }

  useEffect(() => {
    return () => {
      if (intervalRef.current !== null) clearInterval(intervalRef.current);
      if (clickResetRef.current !== null) clearTimeout(clickResetRef.current);
    };
  }, []);

  return (
    <>
      {image ? (
        isLocalProductImageUrl(image.url) ? (
          <img
            key={`${activeIndex}-${image.url}`}
            className="product-gallery-image"
            src={image.url}
            alt={image.altText}
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
        ) : (
          <Image
            key={`${activeIndex}-${image.url}`}
            className="product-gallery-image"
            src={image.url}
            alt={image.altText}
            fill
            sizes={sizes}
          />
        )
      ) : (
        <span className="image-placeholder">Image awaiting review</span>
      )}
      {images.length > 1 && (
        <span className="product-gallery-position" aria-hidden="true">
          {activeIndex + 1} / {images.length}
        </span>
      )}
      <span className="visually-hidden" aria-live="polite">
        {image ? `${title}, image ${activeIndex + 1} of ${images.length}` : ""}
      </span>
      <span
        className="product-gallery-interaction"
        onPointerEnter={handlePointerEnter}
        onPointerLeave={() => stopGallery(true)}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onClick={(event) => {
          if (!suppressClick.current) return;
          event.preventDefault();
          event.stopPropagation();
          suppressClick.current = false;
          if (clickResetRef.current !== null) {
            clearTimeout(clickResetRef.current);
            clickResetRef.current = null;
          }
        }}
      />
    </>
  );
}
