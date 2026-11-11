import React from "react";
import { Shield, ShieldCheck } from "lucide-react";

export function EnvironmentShield({ healthy, className = "", size = 20 }) {
  const Icon = healthy ? ShieldCheck : Shield;
  return (
    <Icon
      size={size}
      className={`environment-shield ${healthy ? "healthy" : ""} ${className}`}
      role="img"
      aria-label={healthy ? "Среда работает нормально, проверка сети пройдена" : "Среда Cage"}
      strokeWidth={1.8}
    />
  );
}
