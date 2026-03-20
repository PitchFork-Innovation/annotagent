import type { AnnotationType } from "./types";

export function annotationTone(type: AnnotationType) {
  switch (type) {
    case "definition":
      return "#c78a24";
    case "highlight":
      return "#dc6d57";
    case "note":
    default:
      return "#3a628f";
  }
}

export function importanceStyle(importance: 1 | 2 | 3) {
  if (importance === 3) {
    return { strokeWidth: 2.9, opacity: 0.95 };
  }

  if (importance === 2) {
    return { strokeWidth: 2.2, opacity: 0.75 };
  }

  return { strokeWidth: 1.6, opacity: 0.5 };
}
