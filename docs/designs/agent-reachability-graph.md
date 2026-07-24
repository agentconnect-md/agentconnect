# Agent reachability graph

## Purpose

The Agents console has a **Topology** overview (internally the agent
reachability graph) that projects the directional visibility configuration as a
directed graph. It answers two questions without
changing authorization behavior:

- Which visible agent-to-agent direct-call paths are configured?
- From one agent, which other agents are transitively upstream or downstream?

This graph is not assumed to be acyclic. Mutual policies can produce two-way
edges and longer cycles.

## Edge definition

For two distinct agents `A` and `B`, the graph contains the direct edge
`A → B` exactly when both predicates hold:

1. `A.outboundPolicy` admits `B`.
2. `B.callPolicy` admits `A`.

The graph uses the same effective-edge rule as `listAgents` and `messageAgent`.
It computes only over Agent DTOs already visible to the signed-in user, so it
cannot reveal restricted agents or hidden allow-list entries.

## What the graph represents

The graph is a **configured control-plane projection**. An arrow means the
directional policies permit a direct call. Successful delivery can still depend
on runtime conditions such as placement, daemon/relay availability, shared
channel membership, and hop limits.

The overview is therefore explanatory UI, not an authorization oracle and not
a data-plane dependency. The daemon and relay continue to enforce every call.

## Cycles and layout

The console finds strongly connected components (SCCs) to identify agents that
can reach one another through directed paths. SCC condensation is used only for
left-to-right layout:

- a one-agent component is an ordinary graph node;
- a multi-agent component appears in the cycle-group selector;
- the condensed components form a DAG for layout, while the UI still renders
  every original directed edge, including the cycle edges.

Within a layer, nodes wrap into balanced sub-columns once the layer grows past
a height budget, so shallow-but-wide topologies (many roots, one large mutual
group) expand sideways instead of producing one very tall column. Cycle edges
that point at an earlier sub-column route through the gutters rather than
across the nodes in between.

Selecting a cycle group highlights all of its agents and internal directed
edges. The graph does not repeat a cycle badge on every member node; group-level
selection keeps the relationship discoverable without adding redundant labels.

When a user focuses an agent, the console traverses both adjacency directions
to highlight its transitive upstream and downstream neighborhood.

## Scale and evolution

The first implementation derives and lays out the graph in the browser from the
existing agent list. This keeps the server surface unchanged and naturally
inherits resource-visibility filtering. Allow-lists are indexed as sets before
the pairwise scan, so the edge build is `O(n² + p)`, where `p` is the total
number of configured allow-list entries. This is appropriate for the current
console fleet sizes.

If fleets outgrow the browser projection, a later API may return a precomputed
visible subgraph. That endpoint must apply the same human resource visibility
filter before returning nodes or edges; it must not expose hidden agent IDs.
