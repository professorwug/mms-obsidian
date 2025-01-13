import logging
from typing import Optional, Any, Dict
import traceback

class ZettelError(Exception):
    """Base exception class for Zettelfiles errors"""
    def __init__(self, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.details = details or {}

class FileOperationError(ZettelError):
    """Raised when a file operation fails"""
    pass

class GraphOperationError(ZettelError):
    """Raised when a graph operation fails"""
    pass

def setup_logging():
    """Configure logging for the application"""
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        handlers=[
            logging.StreamHandler(),
            logging.FileHandler('zettelfiles.log')
        ]
    )

def log_operation(logger: logging.Logger, operation: str, **kwargs):
    """Log an operation with its parameters"""
    logger.info(f"Operation: {operation}", extra={"parameters": kwargs})

def handle_error(logger: logging.Logger, error: Exception, operation: str) -> Dict[str, Any]:
    """Handle and log an error, return error response"""
    error_details = {
        "type": type(error).__name__,
        "message": str(error),
        "operation": operation,
        "traceback": traceback.format_exc()
    }
    
    if isinstance(error, ZettelError):
        error_details.update(error.details)
        
    logger.error(
        f"Error during {operation}: {str(error)}",
        extra={"error_details": error_details},
        exc_info=True
    )
    
    return {
        "type": "error",
        "message": str(error),
        "details": error_details
    }
