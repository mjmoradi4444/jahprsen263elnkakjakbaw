import React, { useEffect, useState } from 'react';
import { api } from '../api/client';

interface AuthenticatedImageProps {
  fileId: string;
  alt: string;
  className?: string;
}

export function AuthenticatedImage({ fileId, alt, className }: AuthenticatedImageProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let createdUrl: string | null = null;
    setFailed(false);
    setSrc(null);

    api
      .fetchFileBlobUrl(fileId)
      .then(({ blobUrl }) => {
        if (!active) {
          URL.revokeObjectURL(blobUrl);
          return;
        }
        createdUrl = blobUrl;
        setSrc(blobUrl);
      })
      .catch(() => {
        if (active) setFailed(true);
      });

    return () => {
      active = false;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [fileId]);

  if (failed) {
    return (
      <div className={`bg-slate-100 text-slate-500 text-xs flex items-center justify-center p-2 ${className || ''}`}>
        خطا در بارگذاری تصویر
      </div>
    );
  }

  if (!src) {
    return <div className={`bg-slate-100 animate-pulse ${className || ''}`} aria-label="در حال بارگذاری تصویر" />;
  }

  return <img src={src} alt={alt} className={className} referrerPolicy="no-referrer" />;
}
