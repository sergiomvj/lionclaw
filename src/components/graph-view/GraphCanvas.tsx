import { useEffect, useRef, useCallback } from 'react';
import * as d3 from 'd3';
import type { GraphNode, GraphEdge } from '@/types';
import { NODE_COLORS, EDGE_COLOR, EDGE_HIGHLIGHT_COLOR, BG_COLOR, LABEL_STYLE, nodeRadius } from './graph-styles';

interface SimNode extends GraphNode, d3.SimulationNodeDatum {}
interface SimEdge extends d3.SimulationLinkDatum<SimNode> {
  source: SimNode | string;
  target: SimNode | string;
}

interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeClick: (nodeId: string, nodeType: string) => void;
  /** Node IDs that match current filter/search. null = all visible */
  activeNodeIds: Set<string> | null;
  zoomIn?: number;
  zoomOut?: number;
}

export function GraphCanvas({ nodes, edges, onNodeClick, activeNodeIds, zoomIn, zoomOut }: GraphCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown>>();
  const prevZoomIn = useRef(zoomIn);
  const prevZoomOut = useRef(zoomOut);

  // Handle external zoom triggers
  useEffect(() => {
    if (!svgRef.current || !zoomRef.current) return;
    const svg = d3.select(svgRef.current);
    if (zoomIn !== undefined && zoomIn !== prevZoomIn.current) {
      svg.transition().duration(300).call(zoomRef.current.scaleBy, 1.3);
    }
    prevZoomIn.current = zoomIn;
  }, [zoomIn]);

  useEffect(() => {
    if (!svgRef.current || !zoomRef.current) return;
    const svg = d3.select(svgRef.current);
    if (zoomOut !== undefined && zoomOut !== prevZoomOut.current) {
      svg.transition().duration(300).call(zoomRef.current.scaleBy, 0.7);
    }
    prevZoomOut.current = zoomOut;
  }, [zoomOut]);

  // Update opacity based on active filter
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);

    svg.selectAll<SVGCircleElement, SimNode>('.graph-node')
      .attr('opacity', d => activeNodeIds === null || activeNodeIds.has(d.id) ? 1 : 0.12);
    svg.selectAll<SVGTextElement, SimNode>('.graph-label')
      .attr('opacity', d => activeNodeIds === null || activeNodeIds.has(d.id) ? 1 : 0.12);
    svg.selectAll<SVGLineElement, SimEdge>('.graph-edge')
      .attr('opacity', d => {
        const sId = typeof d.source === 'object' ? d.source.id : d.source;
        const tId = typeof d.target === 'object' ? d.target.id : d.target;
        if (activeNodeIds === null) return 0.6;
        return activeNodeIds.has(sId) && activeNodeIds.has(tId) ? 0.6 : 0.05;
      });
  }, [activeNodeIds]);

  const buildGraph = useCallback(() => {
    const svg = d3.select(svgRef.current!);
    svg.selectAll('*').remove();

    const width = svgRef.current!.clientWidth;
    const height = svgRef.current!.clientHeight;

    // Background
    svg.append('rect').attr('width', width).attr('height', height).attr('fill', BG_COLOR);

    // Container for zoom/pan
    const g = svg.append('g');

    // Zoom behavior
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 6])
      .on('zoom', (event) => g.attr('transform', event.transform));
    svg.call(zoom);
    zoomRef.current = zoom;

    // Prepare simulation data (deep copy to avoid mutation)
    const simNodes: SimNode[] = nodes.map(n => ({ ...n }));
    const simEdges: SimEdge[] = edges.map(e => ({ source: e.source, target: e.target }));

    // Build adjacency for hover highlighting
    const adjacency = new Map<string, Set<string>>();
    edges.forEach(e => {
      if (!adjacency.has(e.source)) adjacency.set(e.source, new Set());
      if (!adjacency.has(e.target)) adjacency.set(e.target, new Set());
      adjacency.get(e.source)!.add(e.target);
      adjacency.get(e.target)!.add(e.source);
    });

    // Simulation
    const simulation = d3.forceSimulation<SimNode>(simNodes)
      .force('link', d3.forceLink<SimNode, SimEdge>(simEdges).id(d => d.id).distance(80))
      .force('charge', d3.forceManyBody().strength(-200))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide<SimNode>().radius(d => nodeRadius(d.connections) + 4));

    // Edges
    const edgeSelection = g.append('g')
      .selectAll('line')
      .data(simEdges)
      .join('line')
      .attr('class', 'graph-edge')
      .attr('stroke', EDGE_COLOR)
      .attr('stroke-width', 1)
      .attr('opacity', 0.6);

    // Node groups
    const nodeGroup = g.append('g')
      .selectAll<SVGGElement, SimNode>('g')
      .data(simNodes)
      .join('g')
      .style('cursor', 'pointer');

    // Circles
    nodeGroup.append('circle')
      .attr('class', 'graph-node')
      .attr('r', d => nodeRadius(d.connections))
      .attr('fill', d => NODE_COLORS[d.type] || '#888888')
      .attr('stroke', 'transparent')
      .attr('stroke-width', 2);

    // Labels
    nodeGroup.append('text')
      .attr('class', 'graph-label')
      .text(d => d.title.length > 18 ? d.title.slice(0, 16) + '...' : d.title)
      .attr('dy', d => nodeRadius(d.connections) + 14)
      .attr('text-anchor', 'middle')
      .attr('font-family', LABEL_STYLE.fontFamily)
      .attr('font-size', LABEL_STYLE.fontSize)
      .attr('fill', LABEL_STYLE.fill)
      .attr('pointer-events', 'none');

    // Hover highlight
    nodeGroup
      .on('mouseenter', (_, d) => {
        const neighbors = adjacency.get(d.id) || new Set();
        nodeGroup.select('circle')
          .attr('opacity', (n: unknown) => {
            const node = n as SimNode;
            return node.id === d.id || neighbors.has(node.id) ? 1 : 0.15;
          });
        nodeGroup.select('text')
          .attr('opacity', (n: unknown) => {
            const node = n as SimNode;
            return node.id === d.id || neighbors.has(node.id) ? 1 : 0.15;
          });
        edgeSelection
          .attr('stroke', (e: unknown) => {
            const edge = e as SimEdge;
            const sId = typeof edge.source === 'object' ? (edge.source as SimNode).id : edge.source;
            const tId = typeof edge.target === 'object' ? (edge.target as SimNode).id : edge.target;
            return (sId === d.id || tId === d.id) ? EDGE_HIGHLIGHT_COLOR : EDGE_COLOR;
          })
          .attr('stroke-width', (e: unknown) => {
            const edge = e as SimEdge;
            const sId = typeof edge.source === 'object' ? (edge.source as SimNode).id : edge.source;
            const tId = typeof edge.target === 'object' ? (edge.target as SimNode).id : edge.target;
            return (sId === d.id || tId === d.id) ? 2 : 1;
          })
          .attr('opacity', (e: unknown) => {
            const edge = e as SimEdge;
            const sId = typeof edge.source === 'object' ? (edge.source as SimNode).id : edge.source;
            const tId = typeof edge.target === 'object' ? (edge.target as SimNode).id : edge.target;
            return (sId === d.id || tId === d.id) ? 1 : 0.1;
          });
      })
      .on('mouseleave', () => {
        nodeGroup.select('circle').attr('opacity', (n: unknown) => {
          const node = n as SimNode;
          return activeNodeIds === null || activeNodeIds.has(node.id) ? 1 : 0.12;
        });
        nodeGroup.select('text').attr('opacity', (n: unknown) => {
          const node = n as SimNode;
          return activeNodeIds === null || activeNodeIds.has(node.id) ? 1 : 0.12;
        });
        edgeSelection
          .attr('stroke', EDGE_COLOR)
          .attr('stroke-width', 1)
          .attr('opacity', (e: unknown) => {
            const edge = e as SimEdge;
            if (activeNodeIds === null) return 0.6;
            const sId = typeof edge.source === 'object' ? (edge.source as SimNode).id : edge.source;
            const tId = typeof edge.target === 'object' ? (edge.target as SimNode).id : edge.target;
            return activeNodeIds.has(sId) && activeNodeIds.has(tId) ? 0.6 : 0.05;
          });
      });

    // Click
    nodeGroup.on('click', (_, d) => onNodeClick(d.id, d.type));

    // Drag
    const drag = d3.drag<SVGGElement, SimNode>()
      .on('start', (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });
    nodeGroup.call(drag);

    // Tick
    simulation.on('tick', () => {
      edgeSelection
        .attr('x1', d => (d.source as SimNode).x!)
        .attr('y1', d => (d.source as SimNode).y!)
        .attr('x2', d => (d.target as SimNode).x!)
        .attr('y2', d => (d.target as SimNode).y!);

      nodeGroup.attr('transform', d => `translate(${d.x},${d.y})`);
    });

    return () => { simulation.stop(); };
  }, [nodes, edges, onNodeClick, activeNodeIds]);

  useEffect(() => {
    if (!svgRef.current || nodes.length === 0) return;
    const cleanup = buildGraph();
    return cleanup;
  }, [buildGraph]);

  return (
    <svg
      ref={svgRef}
      className="w-full h-full"
      style={{ background: BG_COLOR }}
    />
  );
}
