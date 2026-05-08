import { BrowserWindow, Notification } from 'electron';
import { CronExpressionParser } from 'cron-parser';
import crypto from 'crypto';
import { getDb, createSession } from './db';
import { createLogger } from './logger';
import { executeBackgroundQuery } from './orchestrator';
import { sendTelegramNotification, isTelegramConfigured } from './telegram-bridge';
import type { ScheduledTask, TaskRun } from '../../src/types';

const logger = createLogger('scheduler');

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let getWindowFn: (() => BrowserWindow | null) | null = null;
const runningTasks = new Set<string>();

export function startScheduler(getWindow: () => BrowserWindow | null): void {
  getWindowFn = getWindow;

  // Check tasks every 30 seconds
  schedulerInterval = setInterval(() => {
    checkAndRunTasks();
  }, 30_000);

  // Initial check
  checkAndRunTasks();
  logger.info('Scheduler started');
}

export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  logger.info('Scheduler stopped');
}

async function checkAndRunTasks(): Promise<void> {
  const db = getDb();
  const now = new Date();

  const tasks = db.prepare(`
    SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run <= ?
  `).all(now.toISOString()) as Array<Record<string, unknown>>;

  for (const task of tasks) {
    const taskId = task['id'] as string;
    const taskName = task['name'] as string;
    const prompt = task['prompt'] as string;
    const scheduleType = task['schedule_type'] as string;
    const scheduleValue = task['schedule_value'] as string;
    const subagent = task['subagent'] as string | null;
    const notify = (task['notify'] as number) === 1;

    // Skip if already running
    if (runningTasks.has(taskId)) {
      logger.debug({ taskId, taskName }, 'Task already running, skipping');
      continue;
    }

    // Lock: mark as running + clear next_run BEFORE async execution
    runningTasks.add(taskId);
    db.prepare(`UPDATE scheduled_tasks SET next_run = NULL WHERE id = ?`).run(taskId);

    logger.info({ taskId, taskName }, 'Running scheduled task');

    // 1. Create isolated session for this task run
    const sessionId = crypto.randomUUID();
    createSession(sessionId, `[Scheduler] ${taskName}`, subagent || undefined, {
      type: 'scheduled',
      taskId,
    });

    // 2. Insert task run with session reference
    const scheduledFor = task['next_run'] as string || new Date().toISOString();
    const runResult = db.prepare(`
      INSERT INTO task_runs (task_id, started_at, status, session_id, scheduled_for)
      VALUES (?, datetime('now'), 'running', ?, ?)
    `).run(taskId, sessionId, scheduledFor);
    const runId = runResult.lastInsertRowid as number;

    // 3. Execute async (fire and forget within the loop, unlock when done)
    runTaskAsync(taskId, taskName, prompt, subagent, sessionId, runId, scheduleType, scheduleValue, notify);
  }
}

async function runTaskAsync(
  taskId: string,
  taskName: string,
  prompt: string,
  subagent: string | null,
  sessionId: string,
  runId: number,
  scheduleType: string,
  scheduleValue: string,
  notify: boolean,
): Promise<void> {
  const db = getDb();

  try {
    // Execute silently - messages/artifacts are saved to DB but NOT streamed to main chat.
    // User views results via "Ver Sessao" which loads from DB.
    if (getWindowFn) {
      await executeBackgroundQuery(prompt, {
        agentId: subagent || undefined,
        sessionId,
        silent: true,
      }, getWindowFn);
    }

    // Mark run as success + pending_review
    db.prepare(`
      UPDATE task_runs SET completed_at = datetime('now'), status = 'success', review_status = 'pending_review' WHERE id = ?
    `).run(runId);

    if (notify) {
      showNotification(taskName, 'Tarefa concluida - clique para revisar');
      if (isTelegramConfigured()) {
        sendTelegramNotification(`Tarefa "${taskName}" concluida com sucesso. Abra o app para revisar.`).catch(() => {});
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';

    db.prepare(`
      UPDATE task_runs SET completed_at = datetime('now'), status = 'error', error = ? WHERE id = ?
    `).run(errorMsg, runId);

    if (notify) {
      showNotification(taskName, `Erro: ${errorMsg.substring(0, 100)}`);
      if (isTelegramConfigured()) {
        sendTelegramNotification(`Tarefa "${taskName}" falhou: ${errorMsg.substring(0, 200)}`).catch(() => {});
      }
    }

    logger.error({ taskId, error }, 'Task execution failed');
  } finally {
    // Unlock task
    runningTasks.delete(taskId);

    // Update task: last_run, run_count, next_run
    const nextRun = scheduleType === 'once' ? null : calculateNextRun(scheduleType, scheduleValue);

    db.prepare(`
      UPDATE scheduled_tasks
      SET last_run = datetime('now'),
          run_count = run_count + 1,
          next_run = ?,
          status = ?
      WHERE id = ?
    `).run(
      nextRun?.toISOString() || null,
      scheduleType === 'once' ? 'completed' : 'active',
      taskId,
    );

    logger.info({ taskId, taskName }, 'Scheduled task completed');
  }
}

function calculateNextRun(scheduleType: string, scheduleValue: string): Date | null {
  switch (scheduleType) {
    case 'cron': {
      try {
        const interval = CronExpressionParser.parse(scheduleValue);
        return interval.next().toDate();
      } catch {
        logger.error({ scheduleValue }, 'Invalid cron expression');
        return null;
      }
    }
    case 'interval': {
      const ms = parseInt(scheduleValue, 10);
      if (isNaN(ms)) return null;
      return new Date(Date.now() + ms);
    }
    case 'once': {
      const date = new Date(scheduleValue);
      return isNaN(date.getTime()) ? null : date;
    }
    default:
      return null;
  }
}

function showNotification(title: string, body: string): void {
  if (Notification.isSupported()) {
    new Notification({ title: `LionClaw: ${title}`, body }).show();
  }
}

// ---- CRUD for scheduler IPC ----

export function getAllScheduledTasks(): ScheduledTask[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
  return rows.map(mapTask);
}

export function createScheduledTask(task: Omit<ScheduledTask, 'id' | 'lastRun' | 'nextRun' | 'runCount'>): ScheduledTask {
  const db = getDb();
  const id = crypto.randomUUID();

  const nextRun = calculateNextRun(task.scheduleType, task.scheduleValue);

  db.prepare(`
    INSERT INTO scheduled_tasks (id, name, prompt, subagent, schedule_type, schedule_value, status, next_run, notify, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    task.name,
    task.prompt,
    task.subagent || null,
    task.scheduleType,
    task.scheduleValue,
    task.status,
    nextRun?.toISOString() || null,
    task.notify ? 1 : 0,
    JSON.stringify(task.tags || []),
  );

  return getScheduledTask(id)!;
}

export function updateScheduledTask(id: string, updates: Partial<ScheduledTask>): ScheduledTask {
  const db = getDb();
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.prompt !== undefined) { fields.push('prompt = ?'); values.push(updates.prompt); }
  if (updates.subagent !== undefined) { fields.push('subagent = ?'); values.push(updates.subagent); }
  if (updates.scheduleType !== undefined) { fields.push('schedule_type = ?'); values.push(updates.scheduleType); }
  if (updates.scheduleValue !== undefined) { fields.push('schedule_value = ?'); values.push(updates.scheduleValue); }
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
  if (updates.notify !== undefined) { fields.push('notify = ?'); values.push(updates.notify ? 1 : 0); }
  if (updates.tags !== undefined) { fields.push('tags = ?'); values.push(JSON.stringify(updates.tags)); }

  if (fields.length > 0) {
    values.push(id);
    db.prepare(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  // Recalculate next_run if schedule changed
  if (updates.scheduleType || updates.scheduleValue) {
    const task = getScheduledTask(id);
    if (task) {
      const nextRun = calculateNextRun(task.scheduleType, task.scheduleValue);
      db.prepare('UPDATE scheduled_tasks SET next_run = ? WHERE id = ?').run(nextRun?.toISOString() || null, id);
    }
  }

  return getScheduledTask(id)!;
}

export function deleteScheduledTask(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM task_runs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getTaskRuns(taskId: string): TaskRun[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 50'
  ).all(taskId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r['id'] as number,
    taskId: r['task_id'] as string,
    startedAt: r['started_at'] as string,
    completedAt: r['completed_at'] as string | undefined,
    status: r['status'] as TaskRun['status'],
    result: r['result'] as string | undefined,
    error: r['error'] as string | undefined,
    tokensUsed: (r['tokens_used'] as number) || 0,
    costUsd: (r['cost_usd'] as number) || 0,
    sessionId: r['session_id'] as string | undefined,
    reviewStatus: r['review_status'] as TaskRun['reviewStatus'],
    reviewNote: r['review_note'] as string | undefined,
    reviewedAt: r['reviewed_at'] as string | undefined,
  }));
}

export function reviewTaskRun(runId: number, status: 'validated' | 'rejected', note?: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE task_runs SET review_status = ?, review_note = ?, reviewed_at = datetime('now') WHERE id = ?
  `).run(status, note || null, runId);
}

export function getPendingReviewCount(): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT COUNT(*) as c FROM task_runs WHERE review_status = 'pending_review'"
  ).get() as { c: number };
  return row.c;
}

function getScheduledTask(id: string): ScheduledTask | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return mapTask(row);
}

function mapTask(row: Record<string, unknown>): ScheduledTask {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    prompt: row['prompt'] as string,
    subagent: row['subagent'] as string | undefined,
    scheduleType: row['schedule_type'] as ScheduledTask['scheduleType'],
    scheduleValue: row['schedule_value'] as string,
    status: row['status'] as ScheduledTask['status'],
    lastRun: row['last_run'] as string | undefined,
    nextRun: row['next_run'] as string | undefined,
    runCount: (row['run_count'] as number) || 0,
    notify: (row['notify'] as number) === 1,
    tags: JSON.parse((row['tags'] as string) || '[]'),
  };
}

// ---- Activity Board queries ----

export interface ActivityItem {
  runId: number;
  taskId: string;
  taskName: string;
  prompt: string;
  subagent: string | null;
  tags: string[];
  scheduledFor: string;
  startedAt: string | null;
  completedAt: string | null;
  status: 'scheduled' | 'running' | 'success' | 'error';
  reviewStatus: 'pending_review' | 'validated' | 'rejected' | null;
  sessionId: string | null;
  error: string | null;
}

/**
 * Projects all future occurrences of a task within a date range.
 * For cron: iterates the cron expression. For interval: steps from next_run.
 * For once: just the single next_run if it falls in range.
 * Returns ISO datetime strings.
 */
function projectOccurrences(
  scheduleType: string,
  scheduleValue: string,
  nextRun: string | null,
  from: Date,
  to: Date,
  maxOccurrences = 200,
): string[] {
  const results: string[] = [];

  if (scheduleType === 'cron') {
    try {
      // Start iterating from whichever is earlier: now or period start
      const startFrom = new Date(Math.min(from.getTime(), Date.now()));
      const interval = CronExpressionParser.parse(scheduleValue, { currentDate: startFrom });
      for (let i = 0; i < maxOccurrences; i++) {
        const next = interval.next().toDate();
        if (next >= to) break;
        if (next >= from) {
          results.push(next.toISOString());
        }
      }
    } catch {
      // Invalid cron - fall back to next_run if available
      if (nextRun) {
        const d = new Date(nextRun);
        if (d >= from && d < to) results.push(d.toISOString());
      }
    }
  } else if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (!isNaN(ms) && ms > 0 && nextRun) {
      // Walk backwards from next_run to find the first occurrence >= from,
      // then walk forward until we pass to.
      let cursor = new Date(nextRun).getTime();
      // Step backwards to find earliest occurrence >= from
      while (cursor - ms >= from.getTime()) {
        cursor -= ms;
      }
      // Now walk forward
      for (let i = 0; i < maxOccurrences; i++) {
        if (cursor >= to.getTime()) break;
        if (cursor >= from.getTime()) {
          results.push(new Date(cursor).toISOString());
        }
        cursor += ms;
      }
    }
  } else if (scheduleType === 'once') {
    if (nextRun) {
      const d = new Date(nextRun);
      if (d >= from && d < to) results.push(d.toISOString());
    }
  }

  return results;
}

export function getActivities(filters: {
  from: string;
  to: string;
  subagent?: string;
  status?: string;
  tags?: string[];
}): ActivityItem[] {
  const db = getDb();

  // ---- 1. Past/current runs (use COALESCE for runs without scheduled_for) ----
  const runConditions: string[] = [
    '(COALESCE(tr.scheduled_for, tr.started_at) >= ? AND COALESCE(tr.scheduled_for, tr.started_at) < ?)',
  ];
  const runParams: unknown[] = [filters.from, filters.to];

  if (filters.subagent) {
    runConditions.push('st.subagent = ?');
    runParams.push(filters.subagent);
  }
  if (filters.status && filters.status !== 'scheduled') {
    runConditions.push('tr.status = ?');
    runParams.push(filters.status);
  }

  const runsQuery = `
    SELECT
      tr.id as run_id,
      tr.task_id,
      st.name as task_name,
      st.prompt,
      st.subagent,
      st.tags,
      COALESCE(tr.scheduled_for, tr.started_at) as scheduled_for,
      tr.started_at,
      tr.completed_at,
      tr.status,
      tr.review_status,
      tr.session_id,
      tr.error
    FROM task_runs tr
    JOIN scheduled_tasks st ON st.id = tr.task_id
    WHERE ${runConditions.join(' AND ')}
    ORDER BY scheduled_for ASC
  `;

  const runs = db.prepare(runsQuery).all(...runParams) as Array<Record<string, unknown>>;

  const items: ActivityItem[] = [];

  for (const r of runs) {
    items.push({
      runId: r['run_id'] as number,
      taskId: r['task_id'] as string,
      taskName: r['task_name'] as string,
      prompt: r['prompt'] as string,
      subagent: (r['subagent'] as string) || null,
      tags: JSON.parse((r['tags'] as string) || '[]'),
      scheduledFor: r['scheduled_for'] as string,
      startedAt: (r['started_at'] as string) || null,
      completedAt: (r['completed_at'] as string) || null,
      status: r['status'] as 'running' | 'success' | 'error',
      reviewStatus: (r['review_status'] as ActivityItem['reviewStatus']) || null,
      sessionId: (r['session_id'] as string) || null,
      error: (r['error'] as string) || null,
    });
  }

  // ---- 2. Future projected occurrences (not yet executed) ----
  if (!filters.status || filters.status === 'scheduled') {
    const taskConditions: string[] = ["st.status = 'active'"];
    const taskParams: unknown[] = [];

    if (filters.subagent) {
      taskConditions.push('st.subagent = ?');
      taskParams.push(filters.subagent);
    }

    const tasksQuery = `
      SELECT
        st.id as task_id,
        st.name as task_name,
        st.prompt,
        st.subagent,
        st.tags,
        st.schedule_type,
        st.schedule_value,
        st.next_run
      FROM scheduled_tasks st
      WHERE ${taskConditions.join(' AND ')}
    `;

    const activeTasks = db.prepare(tasksQuery).all(...taskParams) as Array<Record<string, unknown>>;

    const fromDate = new Date(filters.from);
    const toDate = new Date(filters.to);

    // Collect existing run scheduled_for values to avoid duplicates
    const existingRunTimes = new Set(
      items.map(i => `${i.taskId}|${i.scheduledFor.slice(0, 16)}`),
    );

    for (const t of activeTasks) {
      const taskId = t['task_id'] as string;
      const scheduleType = t['schedule_type'] as string;
      const scheduleValue = t['schedule_value'] as string;
      const nextRun = (t['next_run'] as string) || null;

      const occurrences = projectOccurrences(scheduleType, scheduleValue, nextRun, fromDate, toDate);

      for (const occ of occurrences) {
        // Skip if there's already a run at approximately this time for this task
        const key = `${taskId}|${occ.slice(0, 16)}`;
        if (existingRunTimes.has(key)) continue;

        // Only show future occurrences (not past ones that were missed)
        if (new Date(occ) <= new Date()) continue;

        items.push({
          runId: 0,
          taskId,
          taskName: t['task_name'] as string,
          prompt: t['prompt'] as string,
          subagent: (t['subagent'] as string) || null,
          tags: JSON.parse((t['tags'] as string) || '[]'),
          scheduledFor: occ,
          startedAt: null,
          completedAt: null,
          status: 'scheduled',
          reviewStatus: null,
          sessionId: null,
          error: null,
        });
      }
    }
  }

  // Sort all items by scheduledFor
  items.sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));

  if (filters.tags && filters.tags.length > 0) {
    return items.filter(item =>
      filters.tags!.some(tag => item.tags.includes(tag))
    );
  }

  return items;
}

export function getActivityStats(from: string, to: string): {
  scheduled: number;
  running: number;
  success: number;
  error: number;
} {
  const db = getDb();
  const stats = { scheduled: 0, running: 0, success: 0, error: 0 };

  // Count runs using COALESCE fallback for old runs without scheduled_for
  const rows = db.prepare(`
    SELECT status, COUNT(*) as c
    FROM task_runs
    WHERE COALESCE(scheduled_for, started_at) >= ? AND COALESCE(scheduled_for, started_at) < ?
    GROUP BY status
  `).all(from, to) as Array<{ status: string; c: number }>;

  for (const row of rows) {
    if (row.status in stats) {
      stats[row.status as keyof typeof stats] = row.c;
    }
  }

  // Count projected future occurrences
  const activeTasks = db.prepare(`
    SELECT schedule_type, schedule_value, next_run
    FROM scheduled_tasks
    WHERE status = 'active'
  `).all() as Array<Record<string, unknown>>;

  const fromDate = new Date(from);
  const toDate = new Date(to);
  const now = new Date();

  for (const t of activeTasks) {
    const occurrences = projectOccurrences(
      t['schedule_type'] as string,
      t['schedule_value'] as string,
      (t['next_run'] as string) || null,
      fromDate,
      toDate,
    );
    // Only count future occurrences
    stats.scheduled += occurrences.filter(occ => new Date(occ) > now).length;
  }

  return stats;
}

export function getAllTags(): string[] {
  const db = getDb();
  const rows = db.prepare("SELECT DISTINCT tags FROM scheduled_tasks WHERE tags != '[]'").all() as Array<{ tags: string }>;
  const tagSet = new Set<string>();
  for (const row of rows) {
    const tags = JSON.parse(row.tags) as string[];
    tags.forEach(t => tagSet.add(t));
  }
  return Array.from(tagSet).sort();
}
