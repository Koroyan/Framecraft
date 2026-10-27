'use client';

import { createContext, useContext } from 'react';

/*
 * The editor is a full-screen workspace with ONE header row: the app shell hands its home link and
 * its tools (search, credits, notifications) to the editor, which places them in its own header —
 * so no vertical space is spent on a second bar.
 */
export type EditorChromeParts = { home?: React.ReactNode; tools?: React.ReactNode };

export const EditorChrome = createContext<EditorChromeParts>({});
export const useEditorChrome = () => useContext(EditorChrome);
