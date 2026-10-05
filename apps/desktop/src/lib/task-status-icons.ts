import {
    Archive,
    ArrowRight,
    Book,
    Calendar,
    Check,
    Clock3,
    Inbox,
    PauseCircle,
    CalendarClock,
    type LucideIcon,
} from 'lucide-react';
import type { TaskStatus } from '@mindwtr/core';

/**
 * The one home for "which glyph means which status" on desktop (#1256).
 *
 * The sidebar, the editor's Status pills and the inbox-processing wizard each picked their own
 * icons: Someday was a clock in one place and a calendar in another, the hourglass meant Waiting
 * in the editor and Incubate in the wizard, and two wizard buttons in one row shared a clock. An
 * icon only helps if it means one thing, so every surface reads this map.
 *
 * The sidebar's choices win where they existed (they are the oldest and the most seen). Waiting is
 * NOT the hourglass: the same editor already uses the hourglass for Time estimate.
 */
export const TASK_STATUS_ICONS: Record<TaskStatus, LucideIcon> = {
    inbox: Inbox,
    next: ArrowRight,
    waiting: PauseCircle,
    someday: Clock3,
    reference: Book,
    done: Check,
    archived: Archive,
};

/** "Start later" sets a start date, and the editor's Start Date field wears this glyph. */
export const START_LATER_ICON: LucideIcon = Calendar;

/** Incubate is Someday with a review date: choose when to reconsider it. */
export const INCUBATE_ICON: LucideIcon = CalendarClock;
