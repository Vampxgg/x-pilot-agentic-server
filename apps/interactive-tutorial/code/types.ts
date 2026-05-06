export interface ChatRequest {
  message: string;
  conversationId?: string;
  sessionId?: string;
  databaseId?: string;
  smartSearch?: boolean;
  attachments?: string;
}

/** @deprecated Use ChatRequest with /chat-stream instead */
export interface GenerateRequest {
  topic: string;
  userPrompt?: string;
  databaseId?: string;
  smartSearch?: boolean;
  userFiles?: string;
  sessionId?: string;
  conversationId?: string;
  tenant_id?: string;
  user_id?: string;
}

/** @deprecated Use ChatRequest with /chat-stream instead */
export interface EditRequest {
  sessionId: string;
  editPrompt: string;
  conversationId?: string;
  tenant_id?: string;
  user_id?: string;
}

export interface TutorialMeta {
  /** Now always equals sessionId; kept for backward compatibility */
  tutorialId: string;
  title: string;
  url: string;
  createdAt: string;
  lastBuildStatus: "success" | "failed";
  lastSuccessfulBuildAt?: string;
}

export interface TutorialResponse {
  agent: string;
  conversationId: string;
  sessionId: string;
  title: string;
  url: string;
  teachingGuide?: {
    overview: string;
    objectives: string[];
    componentGuides: Array<{
      component: string;
      duration: string;
      tip: string;
    }>;
  };
  metadata: {
    /** Now always equals sessionId */
    tutorialId: string;
    fileCount: number;
    estimatedDuration: string;
    warnings?: string[];
  };
}

export interface FileValidationError {
  file: string;
  errors: string[];
}

export interface BuildError {
  file: string;
  line?: number;
  message: string;
  type: 'syntax' | 'import' | 'type' | 'unknown';
}

export interface RepairRecord {
  round: number;
  filePath: string;
  fixed: boolean;
  originalErrors: string;
}

export interface RuntimeErrorReport {
  sessionId: string;
  /** @deprecated Use sessionId to locate the build directory */
  tutorialId?: string;
  tenantId?: string;
  userId?: string;
  error: {
    message: string;
    stack?: string;
    componentStack?: string;
  };
}
