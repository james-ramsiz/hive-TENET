package swipe

type Service struct {
    jobs   JobReader
    locker SlotLocker
    gate   Gatekeeper
    db     *pgxpool.Pool   // swipe_* tables + outbox ONLY
    outbox outbox.Writer
}

func (s *Service) SwipeRight(ctx context.Context, uid kernel.UserID, jid kernel.JobID) (Result, error) {
    d, err := s.gate.Allow(ctx, uid, kernel.ActionSwipe)
    if err != nil {
        return Result{}, err
    }
    if !d.Allowed {
        return Result{Denied: d.Reason}, nil // rate-limited / throttled — not an error
    }

    job, err := s.jobs.Job(ctx, jid)
    if err != nil {
        return Result{}, err
    }

    if err := s.locker.Reserve(ctx, uid, jid, job.Reward); err != nil {
        return Result{}, err // ErrTaken / ErrEscrowExhausted — surfaces as 409/402
    }

    // Swipe row + outbox event atomically. If anything fails, the Redis lock's
    // TTL is the safety net — we don't need perfect compensation.
    tx, err := s.db.Begin(ctx)
    if err != nil {
        return Result{}, err
    }
    defer tx.Rollback(ctx)

    if err := insertSwipeTx(ctx, tx, uid, jid, DecisionAccept); err != nil {
        return Result{}, err
    }
    if err := s.outbox.AppendTx(ctx, tx, swipeCreatedEvent(uid, jid, job.Reward)); err != nil {
        return Result{}, err
    }
    if err := tx.Commit(ctx); err != nil {
        return Result{}, err
    }
    return Result{Locked: true, Reward: job.Reward}, nil
}
