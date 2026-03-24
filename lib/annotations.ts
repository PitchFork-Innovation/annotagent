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
    return { fillOpacity: 0.3, borderOpacity: 0.48 };
  }

  if (importance === 2) {
    return { fillOpacity: 0.22, borderOpacity: 0.36 };
  }

  return { fillOpacity: 0.16, borderOpacity: 0.24 };
}
