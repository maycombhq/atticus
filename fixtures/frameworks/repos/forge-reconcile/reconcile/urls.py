from django.urls import path

from .views import breaks

urlpatterns = [
    path("breaks/", breaks, name="breaks"),
]
