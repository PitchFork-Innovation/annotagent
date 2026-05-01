export type AnnotationType = "highlight" | "note" | "definition";
export type AnnotationStyle = "default" | "novice" | "expert";
export type AnnotationPathway = "validated" | "direct";
export type PaperSource = "arxiv" | "upload";

export type HighlightFragment = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BoundingBox = HighlightFragment & {
  fragments?: HighlightFragment[];
};

export type TextAnchor = {
  pageTextStart: number;
  pageTextEnd: number;
  occurrenceIndex: number;
};

export type TextAnchorPayload = {
  page_text_start: number;
  page_text_end: number;
  occurrence_index: number;
};

export type AnnotationRecord = {
  id: string;
  paperId: string;
  pageNumber: number;
  type: AnnotationType;
  textRef: string;
  note: string;
  importance: 1 | 2 | 3;
  bbox: BoundingBox;
  anchor?: TextAnchor | null;
};

export type PaperRecord = {
  id: string;
  source: PaperSource;
  arxivId: string | null;
  originalFilename: string | null;
  title: string;
  abstract: string;
  aiSummary: string | null;
  pdfUrl: string;
  pageCount: number;
  fullText: string;
  starterQuestions: string[];
  annotationStyle: AnnotationStyle;
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type PaperWorkspace = {
  paper: PaperRecord;
  annotations: AnnotationRecord[];
  chatHistory: ChatMessage[];
};

export type PaperListItem = {
  id: string;
  source: PaperSource;
  arxivId: string | null;
  originalFilename: string | null;
  title: string;
  abstract: string;
  annotationCount: number;
};

export type UserProfile = {
  id: string;
  email: string;
};

export type IngestionPayload = {
  source: PaperSource;
  arxivId: string | null;
  originalFilename: string | null;
  storagePath: string | null;
  title: string;
  abstract: string;
  summary: string;
  pdfUrl: string;
  fullText: string;
  pageCount: number;
  starterQuestions: string[];
  annotationStyle?: AnnotationStyle;
  annotations: Array<{
    page_number: number;
    type: AnnotationType;
    text_ref: string;
    note: string;
    importance: 1 | 2 | 3;
    bbox: BoundingBox;
    anchor?: TextAnchorPayload | null;
  }>;
};

export type UploadInitResponse = {
  uploadId: string;
  storagePath: string;
  signedUploadUrl: string;
  signedUploadToken: string;
};
