-- A console change to an agent's memory that removes its own change log, such as clearing a place layer, is audited here instead.
ALTER TYPE "AuditKind" ADD VALUE 'memory_change';
