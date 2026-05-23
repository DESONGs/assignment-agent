# Document Revision Overlay

Use this overlay only when `Document Router Conclusion.operation` is
`document_revision`.

This overlay does not define PRD, architecture, operations, checklist, or
meeting-minutes structure. The base document prompt still owns the document
structure. This overlay only constrains how an existing document and its review
context are used.

## Revision Rules

1. Treat `Review Context` as the change request layer over the base evidence.
2. Apply explicit user instructions first, then unresolved comments, then
   inferred improvement opportunities from nearby anchor text.
3. Preserve the original document's intent, project direction, and important
   evidence unless the review context clearly asks for a change.
4. Do not invent comment authors, comment timestamps, reviewer identity,
   approvals, budgets, deadlines, or external facts.
5. If comments are unavailable from the Feishu API/export, state that the
   revision used the exported document body and the user's visible instruction,
   then list missing comment access as `待确认`.
6. Keep unresolved or ambiguous comments in a `待确认问题` or equivalent section
   owned by the base prompt.
7. Comments are source-scoped. Use a comment only with the `sourceId` shown in
   `Review Context.sourceDocuments`; never apply one source's comment to another
   source's body or conclusions.
8. Use `matchStatus` strictly:
   - `exact_unique`: may drive a local section-level revision.
   - `exact_multiple` or `fuzzy`: treat as weak location evidence; revise only
     if the intended target is clear, otherwise preserve as `待确认`.
   - `unmatched`: do not pretend it was applied; preserve it as `待确认`.
   - `exported_body_detected`: treat as exported-body fallback, not as an
     independently read Feishu comment thread.
9. Do not publish or overwrite by yourself. The runner and Policy Gate decide
   whether the revised document is created as a new version or overwrites an
   explicit target.

## Revision Output Requirements

- Output the revised full Markdown document, not a chat answer.
- Keep the H1 aligned with the document title plan unless the review context
  clearly requests a title change.
- Integrate comment-driven changes into the correct sections instead of adding a
  loose "comments" appendix when the target section is clear.
- If a comment cannot be applied safely, keep the original content and add a
  concise待确认 item.
- If any source has unavailable comment access, state which sourceId was not
  fully reviewed instead of claiming all comments were processed.
- Avoid long descriptions of this process in the final document.
