/** Public unified API projection; timestamps are UTC epoch milliseconds, IDs are opaque strings. */
export interface UnifiedEmailSummary {
  id: string
  source: string
  account_id: string | null
  from_addr: string
  to_addr: string
  subject: string | null
  received_at: number
  is_read: number
  is_starred: number
}

export interface UnifiedEmailDetail extends UnifiedEmailSummary {
  text_body: string | null
  html_body: string | null
  attachments_json: string | null
}

export interface UnifiedListQuery {
  source?: string
  account_id?: string
  to_addr?: string
  q?: string
  unread?: 0 | 1
  starred?: 0 | 1
  limit?: number
  offset?: number
  cursor?: string
  with_count?: 0 | 1
}

export interface UnifiedListResponse {
  results: UnifiedEmailSummary[]
  count: number | null
  next_cursor?: string | null
  has_more?: boolean
  degraded?: string[]
}

export interface RequestOptions {
  signal?: AbortSignal
  headers?: Record<string, string>
}

export interface UnifiedAuthSnapshot {
  key: string
  headers: Record<string, string>
}

export interface UnifiedMutationResult {
  status: 'queued' | 'pending' | 'processing' | 'succeeded' | 'failed' | 'unsupported' | 'superseded'
  job_id?: string
  desired_value?: number | null
  is_read?: number
  is_starred?: number
  target_folder?: string | null
  target_folder_id?: string | null
  deleted?: boolean
  error?: string | null
}

export interface MutationPollOptions {
  initialAuth?: UnifiedAuthSnapshot
  getAuth: () => UnifiedAuthSnapshot
  fetchStatus: (jobId: string, auth: UnifiedAuthSnapshot, options: RequestOptions) => Promise<UnifiedMutationResult>
  signal?: AbortSignal
  pollMs?: number
  timeoutMs?: number
  sleepImpl?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

export interface MutationApiDependencies extends Pick<MutationPollOptions, 'getAuth' | 'pollMs' | 'timeoutMs' | 'sleepImpl'> {
  request: (path: string, options: RequestOptions & { method?: string; body?: Record<string, unknown> }) => Promise<UnifiedMutationResult>
}
