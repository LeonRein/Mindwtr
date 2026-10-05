import {
    Archive,
    ArrowRight,
    ArrowUpCircle,
    Book,
    Check,
    Clock3,
    Inbox,
    PauseCircle,
    CalendarClock,
    type LucideIcon,
} from 'lucide-react-native';
import type { TaskStatus } from '@mindwtr/core';

/**
 * The one home for "which glyph means which status" on mobile (#1256).
 *
 * The task editor and the inbox-processing steps each picked their own: the hourglass meant
 * Waiting in the editor and Incubate in the steps, and Someday was a calendar in one and a cloud
 * in the other. Every lucide surface reads this map now.
 *
 * It follows MOBILE's navigation (app/(drawer)/(tabs)/_layout.tsx, a different icon library):
 * Waiting is a pause circle, Someday an up-arrow circle, Reference a closed book. Someday is not
 * a clock here, unlike desktop: on Android the menu already uses the clock for History.
 * Waiting is never the hourglass, which this editor uses for Time estimate.
 */
export const TASK_STATUS_ICONS: Record<TaskStatus, LucideIcon> = {
    inbox: Inbox,
    next: ArrowRight,
    waiting: PauseCircle,
    someday: ArrowUpCircle,
    reference: Book,
    done: Check,
    archived: Archive,
};

/** "Start later" sets a start time. */
export const START_LATER_ICON: LucideIcon = Clock3;

/** Incubate is Someday with a review date: choose when to reconsider it. */
export const INCUBATE_ICON: LucideIcon = CalendarClock;
