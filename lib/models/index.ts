import mongoose, { Schema } from "mongoose";
import { randomUUID } from "crypto";

// ─── Annotation subdocument (embedded in Paper) ────────────────────────────

const AnnotationSubdocSchema = new Schema(
  {
    _id: { type: String, default: () => randomUUID() },
    pageNumber: { type: Number, required: true },
    type: { type: String, required: true },
    textRef: { type: String, required: true },
    note: { type: String, required: true },
    importance: { type: Number, required: true },
    bbox: { type: Schema.Types.Mixed, required: true },
    anchor: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true, _id: false }
);

// ─── Paper ─────────────────────────────────────────────────────────────────

const PaperSchema = new Schema(
  {
    _id: { type: String, default: () => randomUUID() },
    source: { type: String, required: true },
    arxivId: { type: String, default: null },
    originalFilename: { type: String, default: null },
    storagePath: { type: String, default: null },
    title: { type: String, required: true },
    abstract: { type: String, required: true },
    aiSummary: { type: String, default: null },
    pdfUrl: { type: String, required: true },
    pageCount: { type: Number, required: true },
    fullText: { type: String, required: true },
    starterQuestions: { type: [String], default: [] },
    annotationStyle: { type: String, default: "default" },
    annotations: { type: [AnnotationSubdocSchema], default: [] },
  },
  { timestamps: true, _id: false }
);

PaperSchema.index({ arxivId: 1 }, { unique: true, sparse: true });

export const Paper = (mongoose.models.Paper as mongoose.Model<mongoose.InferSchemaType<typeof PaperSchema>>) ??
  mongoose.model("Paper", PaperSchema);

// ─── UserPaper ─────────────────────────────────────────────────────────────

const UserPaperSchema = new Schema(
  {
    _id: { type: String, default: () => randomUUID() },
    userId: { type: String, required: true, index: true },
    paperId: { type: String, required: true },
  },
  { timestamps: true, _id: false }
);

UserPaperSchema.index({ userId: 1, paperId: 1 }, { unique: true });

export const UserPaper = (mongoose.models.UserPaper as mongoose.Model<mongoose.InferSchemaType<typeof UserPaperSchema>>) ??
  mongoose.model("UserPaper", UserPaperSchema);

// ─── Chat ──────────────────────────────────────────────────────────────────

const ChatSchema = new Schema(
  {
    _id: { type: String, default: () => randomUUID() },
    paperId: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    messages: { type: Schema.Types.Mixed, default: [] },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, _id: false }
);

ChatSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Chat = (mongoose.models.Chat as mongoose.Model<mongoose.InferSchemaType<typeof ChatSchema>>) ??
  mongoose.model("Chat", ChatSchema);

// ─── PasswordResetToken ────────────────────────────────────────────────────

const PasswordResetTokenSchema = new Schema(
  {
    _id: { type: String, default: () => randomUUID() },
    tokenHash: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
  },
  { _id: false }
);

PasswordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PasswordResetToken = (mongoose.models.PasswordResetToken as mongoose.Model<mongoose.InferSchemaType<typeof PasswordResetTokenSchema>>) ??
  mongoose.model("PasswordResetToken", PasswordResetTokenSchema);
