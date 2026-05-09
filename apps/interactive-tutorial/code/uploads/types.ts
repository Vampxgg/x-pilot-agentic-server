import type { FileKind, FileObject } from "../../../../src/services/file-object-service.js";

export type { FileKind };

/** User-level file object resolved through this tutorial session's binding manifest. */
export interface UploadedFile extends FileObject {
  byteSize: number;
  uploadedAt: string;
}

export interface UploadsManifest {
  version: 2;
  files: Array<{
    fileId: string;
    addedAt: string;
  }>;
}

/** Lightweight summary handed to LLMs via context.userFiles (no body content). */
export interface UserFileSummary {
  fileId: string;
  name: string;
  mimeType: string;
  kind: FileKind;
  byteSize: number;
  url: string;
  textChars?: number;
  unreadable?: boolean;
}

export function toSummary(file: UploadedFile): UserFileSummary {
  return {
    fileId: file.fileId,
    name: file.name,
    mimeType: file.mimeType,
    kind: file.kind,
    byteSize: file.byteSize,
    url: file.url,
    textChars: file.textChars,
    unreadable: file.unreadable,
  };
}
