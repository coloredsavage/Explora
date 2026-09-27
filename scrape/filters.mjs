/* Title filters shared by more than one source.
 *
 * Luma's was the first: its Toronto feed is mostly startup and tech
 * networking. Eventbrite's is the same problem at a larger scale, so it
 * starts from this list rather than keeping a second copy that would drift
 * from it. Deliberately narrow — a book launch or a talk is worth keeping
 * even when a software company is hosting. */
export const NETWORKING = /\b(networking|mixer|housewarming|happy hour|demo day|pitch (night|competition)|founders?|startups?|coworking|mastermind|fintech|saas|b2b|career fair|job fair|hiring|recruit|ama|office hours|speed dating)\b/i;
