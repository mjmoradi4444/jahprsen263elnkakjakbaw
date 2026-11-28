import React, { useEffect, useState } from 'react';
import { api } from '../api/client';

interface AuthenticatedImageProps {
  fileId: string;
  fileUrl?: string | null;
  alt: string;
  className?: string;
}

export function AuthenticatedImage({ fileId, fileUrl, alt, className }: AuthenticatedImageProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let revocableUrl: string | null = null;
    setFailed(false);
    setSrc(null);

    api
      .resolveFileDisplayUrl(fileId, fileUrl)
      .then(({ url, revoke }) => {
        if (!active) {
          if (revoke) URL.revokeObjectURL(url);
          return;
        }
        if (revoke) revocableUrl = url;
        setSrc(url);
      })
      .catch(() => {
        if (active) setFailed(true);
      });

    return () => {
      active = false;
      if (revocableUrl) URL.revokeObjectURL(revocableUrl);
    };
  }, [fileId, fileUrl]);

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
