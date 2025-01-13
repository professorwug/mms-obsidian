from fastapi import FastAPI, WebSocket, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import logging
import asyncio
from typing import List, Dict, Any
from .graph_manager import GraphManager
from .file_manager import FileManager
from .file_operations import get_file_paths, get_obsidian_path, move_files
from .error_handling import (
    setup_logging,
    handle_error,
    log_operation,
    ZettelError,
    FileOperationError,
    GraphOperationError
)
import logging
import os

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)
setup_logging()

app = FastAPI()
manager = GraphManager()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
async def health_check():
    """Simple health check endpoint"""
    return {"status": "ok", "service": "zettelfiles"}

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    logging.debug("New WebSocket connection attempt...")
    try:
        await websocket.accept()
        logging.debug("WebSocket connection accepted")
        file_manager = FileManager(manager)
        
        while True:
            try:
                data = await websocket.receive_json()
                command = data.get("command")
                params = data.get("params", {})
                
                logging.debug(f"Received command: {command} with params: {params}")
                log_operation(logger, command, **params)
                
                try:
                    if command == "initialize":
                        directory = params["directory"]
                        graph = manager.initialize_graph(directory)
                        await websocket.send_json({
                            "type": "success",
                            "data": {
                                "success": True,
                                "data": graph.to_dict()
                            }
                        })
                    
                    elif command == "get_graph":
                        directory = params["directory"]
                        graph = manager.initialize_graph(directory)
                        await websocket.send_json({
                            "type": "success",
                            "data": {
                                "success": True,
                                "data": graph.to_dict()
                            }
                        })
                    
                    elif command == "get_file_paths":
                        directory = params["directory"]
                        node_ids = params["nodeIds"]
                        paths = get_file_paths(directory, node_ids)
                        await websocket.send_json({
                            "type": "success",
                            "data": {"paths": paths}
                        })
                    
                    elif command == "move_files":
                        source_ids = params["sourceIds"]
                        target_id = params["targetId"]
                        logging.debug(f"Moving files: {source_ids} to {target_id}")
                        logging.debug(f"Current base_dir in manager: {manager.base_dir}")
                        success, updated_files = await file_manager.move_files(
                            source_ids,
                            target_id
                        )
                        logging.debug(f"Move result: success={success}, files={updated_files}")
                        await websocket.send_json({
                            "type": "success",
                            "data": {"updatedFiles": updated_files}
                        })
                    
                    elif command == "rename_file":
                        old_path = params["old_path"]
                        new_path = params["new_path"]
                        success, updated_files = await file_manager.rename_file(
                            old_path,
                            new_path
                        )
                        await websocket.send_json({
                            "type": "success",
                            "data": {"updatedFiles": updated_files}
                        })
                    
                    elif command == "create_file":
                        path = params["path"]
                        content = params.get("content", "")
                        success = await file_manager.create_file(path, content)
                        await websocket.send_json({
                            "type": "success",
                            "data": {"created": success}
                        })
                    
                    elif command == "get_obsidian_path":
                        directory = params["directory"]
                        stable_id = params["stableId"]
                        try:
                            obsidian_path = get_obsidian_path(
                                directory,
                                stable_id,
                                manager.graph.to_dict()
                            )
                            await websocket.send_json({
                                "type": "success",
                                "data": {"path": obsidian_path}
                            })
                        except ValueError as e:
                            await websocket.send_json({
                                "type": "error",
                                "message": str(e)
                            })
                    
                    elif command == "watch_changes":
                        directory = params["directory"]
                        manager.watch_directory(
                            directory,
                            lambda update: websocket.send_json({
                                "type": "graph_update",
                                "data": update.to_dict()
                            })
                        )
                    else:
                        raise ZettelError(f"Unknown command: {command}")
                        
                except Exception as e:
                    await websocket.send_json(
                        handle_error(logger, e, command)
                    )
                    
            except Exception as e:
                await websocket.send_json(
                    handle_error(logger, e, "websocket_communication")
                )
    except Exception as e:
        logger.error(f"WebSocket connection error: {str(e)}")
        if websocket.client_state != WebSocket.CLIENT_DISCONNECTED:
            await websocket.close(code=1011, reason=f"Internal server error: {str(e)}")
    finally:
        logger.info("WebSocket connection closed")

def main():
    try:
        print("Starting server on http://127.0.0.1:8000")
        print("WebSocket endpoint at ws://127.0.0.1:8000/ws")
        uvicorn.run(
            app, 
            host="127.0.0.1", 
            port=8000, 
            log_level="debug",
            access_log=True
        )
    except Exception as e:
        print(f"Failed to start server: {str(e)}")
        raise

@app.on_event("startup")
async def startup_event():
    print("FastAPI server starting up...")

if __name__ == "__main__":
    main()
