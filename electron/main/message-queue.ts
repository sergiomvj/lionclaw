import { createLogger } from './logger';

const logger = createLogger('message-queue');

export interface QueuedMessage {
  message: string;
  options: {
    sessionId?: string;
    agentId?: string;
    displayMessage?: string;
    attachments?: Array<{
      id: string;
      type: string;
      filename: string;
      mimeType: string;
      data: string;
      size: number;
    }>;
  };
  enqueuedAt: number;
}

class MessageQueue {
  private queue: QueuedMessage[] = [];
  private _processing = false;

  get isProcessing(): boolean {
    return this._processing;
  }

  set isProcessing(value: boolean) {
    this._processing = value;
  }

  enqueue(item: QueuedMessage): void {
    this.queue.push(item);
    logger.info(
      { queueLength: this.queue.length, message: item.message.substring(0, 80) },
      'Message enqueued',
    );
  }

  dequeue(): QueuedMessage | undefined {
    return this.queue.shift();
  }

  peek(): QueuedMessage | undefined {
    return this.queue[0];
  }

  get length(): number {
    return this.queue.length;
  }

  clear(): void {
    const cleared = this.queue.length;
    this.queue = [];
    if (cleared > 0) {
      logger.info({ cleared }, 'Queue cleared');
    }
  }
}

export const messageQueue = new MessageQueue();
