import sys
import json
from directed_file_graph import build_graph_from_directory, graph_to_dict

def main():
    if len(sys.argv) != 2:
        print(json.dumps({"error": "Base directory not specified"}))
        sys.exit(1)

    base_dir = sys.argv[1]
    try:
        # Build the graph (this will trigger orphan adoption)
        graph = build_graph_from_directory(base_dir)
        
        # Convert the graph to JSON-serializable format
        result = graph_to_dict(graph)
        print(json.dumps({"success": True, "data": result}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))

if __name__ == "__main__":
    main()
